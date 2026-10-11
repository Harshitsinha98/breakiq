create or replace function public.process_scheduled_breaks()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_candidate record;
  v_break public.break_sessions%rowtype;
  v_profile public.profiles%rowtype;
  v_settings jsonb;
  v_max integer;
  v_active integer;
  v_suggested timestamptz;
  v_seq bigint;
  v_processed integer := 0;
  v_promoted integer := 0;
begin
  -- Match lock order used by normal break actions: profile -> project capacity -> break row.
  for v_candidate in
    select b.id, b.user_id, b.project_id
    from public.break_sessions b
    where b.status='APPROVED_SCHEDULED' and b.scheduled_for<=v_now
    order by b.project_id,b.scheduled_for,b.requested_at
    limit 100
  loop
    if v_candidate.user_id is null then
      select * into v_break from public.break_sessions b
      where b.id=v_candidate.id and b.status='APPROVED_SCHEDULED'
      for update skip locked;
      if found then
        update public.break_sessions set status='CANCELLED',cancelled_at=v_now,cancel_reason='SCHEDULE_USER_MISSING'
        where id=v_break.id;
        v_processed:=v_processed+1;
      end if;
      continue;
    end if;

    select * into v_profile from public.profiles p where p.id=v_candidate.user_id for update;
    if not found then
      select * into v_break from public.break_sessions b
      where b.id=v_candidate.id and b.status='APPROVED_SCHEDULED'
      for update skip locked;
      if found then
        update public.break_sessions set status='CANCELLED',cancelled_at=v_now,cancel_reason='SCHEDULE_USER_MISSING'
        where id=v_break.id;
        v_processed:=v_processed+1;
      end if;
      continue;
    end if;

    perform private.lock_project_capacity(v_candidate.project_id);
    select * into v_break from public.break_sessions b
    where b.id=v_candidate.id and b.status='APPROVED_SCHEDULED' and b.scheduled_for<=v_now
    for update skip locked;
    if not found then continue; end if;

    if v_profile.active_shift_id is distinct from v_break.shift_id
       or v_profile.active_break_id is distinct from v_break.id or not v_profile.active then
      update public.break_sessions set status='CANCELLED',cancelled_at=v_now,cancel_reason='SCHEDULE_NO_LONGER_VALID'
      where id=v_break.id;
      delete from public.break_queue_index where break_session_id=v_break.id;
      if v_profile.active_break_id=v_break.id then
        update public.profiles set active_break_id=null,
          status=case when active_shift_id is not null then 'AVAILABLE' else 'OFFLINE' end, updated_at=v_now
        where id=v_profile.id;
      end if;
      v_processed:=v_processed+1;
      continue;
    end if;

    v_settings:=private.effective_settings(v_break.project_id);
    if coalesce((v_settings->>'emergencyLockout')::boolean,false) then
      -- Preserve scheduled reservation while the floor is paused; retry on the next Cron tick.
      continue;
    end if;
    v_max:=greatest(1,coalesce((v_settings->>'maxConcurrentBreaks')::integer,2));

    select count(*) into v_active from public.break_sessions b
    where b.project_id=v_break.project_id and b.id<>v_break.id
      and b.status in ('ON_BREAK','NOTIFIED_TO_START')
      and case when b.status='ON_BREAK'
        then coalesce(b.expected_end_at,v_now+(b.requested_duration_min*interval '1 minute'))>v_now
        else coalesce(b.notified_at,b.requested_at)+(b.requested_duration_min*interval '1 minute')>v_now end;

    if v_active<v_max then
      update public.break_sessions set status='NOTIFIED_TO_START',notified_at=v_now where id=v_break.id;
      update public.profiles set status='NOTIFIED_TO_START',updated_at=v_now
      where id=v_break.user_id and active_break_id=v_break.id;
      v_promoted:=v_promoted+1;
    else
      select min(case when b.status='ON_BREAK'
        then coalesce(b.expected_end_at,v_now+(b.requested_duration_min*interval '1 minute'))
        else coalesce(b.notified_at,b.requested_at)+(b.requested_duration_min*interval '1 minute') end)
      into v_suggested from public.break_sessions b
      where b.project_id=v_break.project_id and b.status in ('ON_BREAK','NOTIFIED_TO_START');

      v_seq:=public.next_counter(v_break.project_id,'queueSeq');
      update public.break_sessions set status='AWAITING_SLOT',expected_end_at=null,queue_seq=v_seq,suggested_time=v_suggested
      where id=v_break.id;
      update public.profiles set status='IN_QUEUE',updated_at=v_now
      where id=v_break.user_id and active_break_id=v_break.id;
      insert into public.break_queue_index(project_id,id,queue_seq,break_session_id,payload,updated_at)
      values(v_break.project_id,v_break.id,v_seq,v_break.id,jsonb_build_object('userId',v_break.user_id,'source','SCHEDULED'),v_now)
      on conflict(project_id,id) do update set queue_seq=excluded.queue_seq,break_session_id=excluded.break_session_id,
        payload=excluded.payload,updated_at=excluded.updated_at;
    end if;
    v_processed:=v_processed+1;
  end loop;
  return jsonb_build_object('processed',v_processed,'notified',v_promoted);
end;
$$;
revoke all on function public.process_scheduled_breaks() from public,anon,authenticated;

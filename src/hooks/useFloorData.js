import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, where } from "../compat/firestore";
import { db } from "../firebase";
import { DEFAULT_SETTINGS } from "../utils/constants";

export function useFloorData(profile) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [agents, setAgents] = useState([]);
  const [activeBreaks, setActiveBreaks] = useState([]);
  const [pendingBreaks, setPendingBreaks] = useState([]);

  useEffect(() => {
    const project = (profile?.project || "GENERAL").trim().toUpperCase();
    let generalData = null;
    let projectData = null;

    const applySettings = () => {
      const selected = project === "GENERAL"
        ? generalData
        : (projectData?.extra?.hasSettingsOverride === true ? projectData : generalData);
      setSettings({ ...DEFAULT_SETTINGS, ...(selected || {}) });
    };

    const unsubscribeGeneral = onSnapshot(
      doc(db, "project_settings", "GENERAL"),
      (snapshot) => {
        generalData = snapshot.exists() ? snapshot.data() : null;
        applySettings();
      }
    );

    const unsubscribeProject = project === "GENERAL"
      ? () => {}
      : onSnapshot(doc(db, "project_settings", project), (snapshot) => {
          projectData = snapshot.exists() ? snapshot.data() : null;
          applySettings();
        });

    return () => {
      unsubscribeGeneral();
      unsubscribeProject();
    };
  }, [profile?.project]);

  useEffect(() => {
    const q = query(collection(db, "users"), where("role", "==", "AGENT"));
    const unsub = onSnapshot(q, (snap) => setAgents(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, []);

  useEffect(() => {
    const q = query(collection(db, "break_sessions"), where("status", "==", "ON_BREAK"), orderBy("breakStartedAt", "asc"));
    const unsub = onSnapshot(q, (snap) => setActiveBreaks(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, []);

  useEffect(() => {
    const q1 = query(collection(db, "break_sessions"), where("status", "==", "AWAITING_SLOT"), orderBy("queueSeq", "asc"));
    const q2 = query(collection(db, "break_sessions"), where("status", "==", "APPROVED_SCHEDULED"), orderBy("scheduledFor", "asc"));
    let queued = [], scheduled = [];
    const merge = () => setPendingBreaks([...queued, ...scheduled]);
    const u1 = onSnapshot(q1, (snap) => { queued = snap.docs.map((d) => ({ id: d.id, kind: "QUEUE", ...d.data() })); merge(); });
    const u2 = onSnapshot(q2, (snap) => { scheduled = snap.docs.map((d) => ({ id: d.id, kind: "SCHEDULED", ...d.data() })); merge(); });
    return () => { u1(); u2(); };
  }, []);

  return { settings, agents, activeBreaks, pendingBreaks };
}

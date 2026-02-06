import React, { useEffect, useMemo, useRef, useState } from "react";
import { ref, onValue, runTransaction, set, update } from "firebase/database";
import { db, ensureAnonymousAuth } from "./firebase";

/** ========= 配置 ========= */
const ADMIN_PASSWORD =
  import.meta.env.VITE_ADMIN_PASSWORD || import.meta.env.REACT_APP_ADMIN_PASSWORD || "ennebei";
const UNANSWERED_PENALTY_MS = 120000;
const ANSWER_MODE_SINGLE = "single"; // 管理员逐题控制
const ANSWER_MODE_ALL = "all"; // 一次性展示全部题目
const ANSWER_OPTIONS = new Set(["A", "B", "C", "D"]);

const LS_PARTICIPANT_ID = "quiz_participant_id";
const LS_DEVICE_ID = "quiz_device_id";
const SS_IGNORE_DEVICE_HIT = "quiz_ignore_device_hit"; // sessionStorage: 一次性忽略本机识别
const LS_THEME_MODE = "quiz_theme_mode";
const THEME_MODE_AUTO = "auto";
const THEME_MODE_DARK = "dark";
const THEME_MODE_LIGHT = "light";

/** ========= 题库（可替换） ========= */
const allQuestions = [
  {
    id: 1,
    question: "以下哪个是 JavaScript 的原始数据类型？\nWhich is a primitive type in JavaScript?",
    options: [
      { id: "A", text: "Array" },
      { id: "B", text: "Object" },
      { id: "C", text: "Symbol" },
      { id: "D", text: "Function" },
    ],
    correctAnswer: "C",
  },
  {
    id: 2,
    question: "React 中哪个 Hook 用于处理副作用？\nWhich Hook handles side effects in React?",
    options: [
      { id: "A", text: "useState" },
      { id: "B", text: "useEffect" },
      { id: "C", text: "useContext" },
      { id: "D", text: "useMemo" },
    ],
    correctAnswer: "B",
  },
  {
    id: 3,
    question: "HTTP 状态码 404 表示什么？\nWhat does HTTP status code 404 mean?",
    options: [
      { id: "A", text: "Server Error" },
      { id: "B", text: "OK" },
      { id: "C", text: "Not Found" },
      { id: "D", text: "Redirect" },
    ],
    correctAnswer: "C",
  },
  {
    id: 4,
    question: "CSS 中哪个属性用于弹性布局？\nWhich property enables flex layout in CSS?",
    options: [
      { id: "A", text: "display: block" },
      { id: "B", text: "display: flex" },
      { id: "C", text: "display: grid" },
      { id: "D", text: "display: inline" },
    ],
    correctAnswer: "B",
  },
];

/** ========= Utils ========= */
const now = () => Date.now();
const normalizeName = (s) => (s || "").trim();
const normalizeNameKey = (s) => normalizeName(s).toLowerCase();
const normalizeRecoveryCode = (s) => (s || "").trim().toUpperCase();
const normalizeAnswerMode = (mode) => (mode === ANSWER_MODE_ALL ? ANSWER_MODE_ALL : ANSWER_MODE_SINGLE);
const normalizeThemeMode = (mode) =>
  mode === THEME_MODE_DARK || mode === THEME_MODE_LIGHT ? mode : THEME_MODE_AUTO;

function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${sec}.${d}s`;
}

function randomId(len = 18) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function toFriendlyError(err, fallback) {
  const code = err?.code || "";
  const step = err?.dbStep ? `（步骤：${err.dbStep}）` : "";
  if (code === "PERMISSION_DENIED" || code.includes("permission-denied")) {
    return `权限不足：请确认 Firebase 匿名登录已开启、Database Rules 已发布，且 Realtime Database 的 App Check 未强制拦截。${step}`;
  }
  if (code.includes("network-request-failed")) {
    return `网络连接失败，请检查网络后重试。${step}`;
  }
  if (!code) return `${fallback}${step}`;
  return `${fallback} (${code})${step}`;
}

function isPermissionDeniedError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  return (
    code.includes("permission-denied") ||
    code === "PERMISSION_DENIED" ||
    message.includes("PERMISSION_DENIED")
  );
}

function getOrCreateDeviceId() {
  let did = localStorage.getItem(LS_DEVICE_ID);
  if (!did) {
    did = `d_${randomId(24)}`;
    localStorage.setItem(LS_DEVICE_ID, did);
  }
  return did;
}

function generateParticipantId() {
  return `p_${now().toString(36)}_${randomId(8)}`;
}

function generateRecoveryCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

function buildSessionState(totalQuestions) {
  return {
    status: "running", // running | stopped
    answerMode: ANSWER_MODE_SINGLE, // single | all
    stoppedAt: null,
    currentQuestionIndex: 0,
    totalQuestions,
    updatedAt: now(),
  };
}

/** ========= DB 初始结构 ========= */
function buildInitialData(totalQuestions) {
  const session = buildSessionState(totalQuestions);
  return {
    // 新结构（推荐）
    session,

    // 旧结构（兼容历史数据）
    quizStatus: session.status,
    answerMode: session.answerMode,
    stoppedAt: session.stoppedAt,
    currentQuestionIndex: session.currentQuestionIndex,
    totalQuestions: session.totalQuestions,

    users: {},
    userNameIndex: {},
    recoveryCodeIndex: {},
    deviceIndex: {},

    userQuizStartTimes: {},
    startTimes: {},
    submissions: {},
  };
}

function readSessionState(raw, fallbackTotalQuestions) {
  const legacy = raw || {};
  const nested = legacy.session || {};

  const totalQuestions =
    Number.isInteger(nested.totalQuestions) && nested.totalQuestions > 0
      ? nested.totalQuestions
      : Number.isInteger(legacy.totalQuestions) && legacy.totalQuestions > 0
      ? legacy.totalQuestions
      : fallbackTotalQuestions;

  return {
    status: nested.status ?? legacy.quizStatus ?? "running",
    answerMode: normalizeAnswerMode(nested.answerMode ?? legacy.answerMode),
    stoppedAt: nested.stoppedAt ?? legacy.stoppedAt ?? null,
    currentQuestionIndex: nested.currentQuestionIndex ?? legacy.currentQuestionIndex ?? 0,
    totalQuestions,
    updatedAt: nested.updatedAt ?? legacy.updatedAt ?? 0,
  };
}

/** ========= Leaderboard ========= */
function computeLeaderboard(
  { users, submissions, userQuizStartTimes },
  totalQuestions,
  { includePenalty, answerMode, sessionStatus, stoppedAt, nowMs }
) {
  const questions = allQuestions.slice(0, totalQuestions);
  const subs = submissions || {};
  const startMap = userQuizStartTimes || {};
  const mode = normalizeAnswerMode(answerMode);

  const userEntries = Object.entries(users || {}).map(([participantId, u]) => ({
    participantId,
    userName: u.userName,
    createdAt: u.createdAt || 0,
  }));

  const rows = userEntries.map((u) => {
    let answeredCount = 0;
    let correctCount = 0;
    let liveTime = 0;
    let latestSubmitTime = 0;
    let firstSubmissionStartTime = 0;

    for (const q of questions) {
      const key = `${u.participantId}_${q.id}`;
      const s = subs[key];
      if (s) {
        answeredCount += 1;
        liveTime += Number(s.duration || 0);
        if (s.isCorrect) correctCount += 1;
        const submitTime = Number(s.submitTime || 0);
        const startTime = Number(s.startTime || 0);
        if (submitTime > latestSubmitTime) latestSubmitTime = submitTime;
        if (startTime > 0 && (firstSubmissionStartTime === 0 || startTime < firstSubmissionStartTime)) {
          firstSubmissionStartTime = startTime;
        }
      }
    }

    const unansweredCount = totalQuestions - answeredCount;
    const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0;
    let totalTime = 0;

    if (mode === ANSWER_MODE_ALL) {
      const entryStart = Number(startMap[u.participantId] || 0) || firstSubmissionStartTime;
      if (entryStart <= 0) {
        liveTime = 0;
        totalTime = 0;
        return {
          participantId: u.participantId,
          userName: u.userName,
          createdAt: u.createdAt,
          answeredCount,
          unansweredCount,
          correctCount,
          accuracy,
          liveTime,
          totalTime,
        };
      }
      let endTime = 0;
      if (answeredCount >= totalQuestions && latestSubmitTime > 0) {
        endTime = latestSubmitTime;
      } else if (sessionStatus === "stopped" && Number(stoppedAt || 0) > 0) {
        endTime = Number(stoppedAt);
      } else {
        endTime = Number(nowMs || now());
      }
      const elapsed = entryStart > 0 ? Math.max(0, endTime - entryStart) : 0;
      liveTime = elapsed;
      totalTime = elapsed;
    } else {
      const penalty = includePenalty ? unansweredCount * UNANSWERED_PENALTY_MS : 0;
      totalTime = liveTime + penalty;
    }

    return {
      participantId: u.participantId,
      userName: u.userName,
      createdAt: u.createdAt,
      answeredCount,
      unansweredCount,
      correctCount,
      accuracy,
      liveTime,
      totalTime,
    };
  });

  rows.sort((a, b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  let rank = 0;
  let lastKey = null;
  return rows.map((r, i) => {
    const k = `${r.accuracy}-${r.totalTime}`;
    if (k !== lastKey) {
      rank = i + 1;
      lastKey = k;
    }
    return { ...r, rank };
  });
}

/** ========= App ========= */
export default function App() {
  const totalQuestions = allQuestions.length;
  const initialData = useMemo(() => buildInitialData(totalQuestions), [totalQuestions]);

  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState("");
  const startTimeWriteInFlightRef = useRef(new Set());

  const [mode, setMode] = useState("participant"); // participant | admin
  const [participantScreen, setParticipantScreen] = useState("entry"); // entry | auth | quiz

  const [participantId, setParticipantId] = useState("");
  const [user, setUser] = useState(null);

  const [deviceHit, setDeviceHit] = useState(null);

  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [recoveryModal, setRecoveryModal] = useState({ open: false, code: "" });

  const [exitStep1Open, setExitStep1Open] = useState(false);
  const [exitStep2Open, setExitStep2Open] = useState(false);
  const [exitClearDevice, setExitClearDevice] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [themeMode, setThemeMode] = useState(() =>
    normalizeThemeMode(localStorage.getItem(LS_THEME_MODE) || THEME_MODE_AUTO)
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true
  );

  /** 匿名认证：配合 RTDB rules（auth != null） */
  useEffect(() => {
    let active = true;
    ensureAnonymousAuth()
      .then(() => {
        if (!active) return;
        setAuthReady(true);
        setAuthError("");
      })
      .catch((err) => {
        if (!active) return;
        setAuthReady(false);
        setIsConnected(false);
        setAuthError(
          `连接失败：匿名登录不可用（${err?.code || "unknown"}）。请在 Firebase Console 开启 Anonymous Auth。`
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_THEME_MODE, themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handle = (ev) => setSystemPrefersDark(ev.matches);
    setSystemPrefersDark(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", handle);
    else mq.addListener(handle);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handle);
      else mq.removeListener(handle);
    };
  }, []);

  /** 订阅 DB */
  useEffect(() => {
    if (!authReady) return;
    const rootRef = ref(db, "/");
    const unsub = onValue(
      rootRef,
      (snap) => {
        const val = snap.val();
        if (!val) {
          set(rootRef, initialData);
          setData(initialData);
          setIsConnected(true);
          return;
        }

        const session = readSessionState(val, totalQuestions);
        setData({
          session,
          quizStatus: session.status,
          answerMode: session.answerMode,
          stoppedAt: session.stoppedAt,
          currentQuestionIndex: session.currentQuestionIndex,
          totalQuestions: session.totalQuestions,

          users: val.users ?? {},
          userNameIndex: val.userNameIndex ?? {},
          recoveryCodeIndex: val.recoveryCodeIndex ?? {},
          deviceIndex: val.deviceIndex ?? {},

          userQuizStartTimes: val.userQuizStartTimes ?? {},
          startTimes: val.startTimes ?? {},
          submissions: val.submissions ?? {},
        });
        setIsConnected(true);
      },
      () => {
        setIsConnected(false);
      }
    );
    return () => unsub();
  }, [authReady, initialData, totalQuestions]);

  /** 自动恢复身份 */
  useEffect(() => {
    if (!isConnected) return;
    const savedPid = localStorage.getItem(LS_PARTICIPANT_ID);
    if (savedPid && data.users?.[savedPid]) {
      setParticipantId(savedPid);
      setUser({ participantId: savedPid, ...data.users[savedPid] });
      return;
    }
    if (savedPid && !data.users?.[savedPid]) localStorage.removeItem(LS_PARTICIPANT_ID);
    setParticipantId("");
    setUser(null);
  }, [data.users, isConnected]);

  /** device 快捷命中 */
  useEffect(() => {
    const did = getOrCreateDeviceId();
    if (localStorage.getItem(LS_PARTICIPANT_ID)) {
      setDeviceHit(null);
      return;
    }
  
    // ✅ 若用户点过“不是我”，本次会话不再弹出 deviceHit
    if (sessionStorage.getItem(SS_IGNORE_DEVICE_HIT) === "1") {
      setDeviceHit(null);
      return;
    }
  
    const hitPid = data.deviceIndex?.[did];
    if (hitPid && data.users?.[hitPid]) {
      setDeviceHit({ participantId: hitPid, userName: data.users[hitPid].userName });
    } else {
      setDeviceHit(null);
    }
  }, [data.deviceIndex, data.users]);

  const answerMode = normalizeAnswerMode(data.session?.answerMode ?? data.answerMode);
  const isSingleMode = answerMode === ANSWER_MODE_SINGLE;
  const resolvedTheme = themeMode === THEME_MODE_AUTO ? (systemPrefersDark ? THEME_MODE_DARK : THEME_MODE_LIGHT) : themeMode;
  const isStopped = data.quizStatus === "stopped";
  const isNaturalEnded = data.quizStatus === "running" && isSingleMode && data.currentQuestionIndex >= totalQuestions;
  const isInProgress = data.quizStatus === "running" && (!isSingleMode || data.currentQuestionIndex < totalQuestions);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    const nextThemeColor = resolvedTheme === THEME_MODE_DARK ? "#081834" : "#d8efff";
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", nextThemeColor);
    });
    document.documentElement.style.colorScheme = resolvedTheme === THEME_MODE_DARK ? "dark" : "light";
  }, [resolvedTheme]);

  useEffect(() => {
    if (answerMode !== ANSWER_MODE_ALL) return;
    if (data.quizStatus !== "running") return;
    const timer = setInterval(() => setClockTick((v) => v + 1), 250);
    return () => clearInterval(timer);
  }, [answerMode, data.quizStatus]);

  const currentQuestion =
    data.currentQuestionIndex >= 0 && data.currentQuestionIndex < totalQuestions
      ? allQuestions[data.currentQuestionIndex]
      : null;

  const leaderboardLive = useMemo(
    () =>
      computeLeaderboard(
        { users: data.users, submissions: data.submissions, userQuizStartTimes: data.userQuizStartTimes },
        totalQuestions,
        {
          includePenalty: false,
          answerMode,
          sessionStatus: data.quizStatus,
          stoppedAt: data.stoppedAt,
          nowMs: now(),
        }
      ),
    [data.users, data.submissions, data.userQuizStartTimes, totalQuestions, answerMode, data.quizStatus, data.stoppedAt, clockTick]
  );

  const leaderboardFinal = useMemo(
    () =>
      computeLeaderboard(
        { users: data.users, submissions: data.submissions, userQuizStartTimes: data.userQuizStartTimes },
        totalQuestions,
        {
          includePenalty: true,
          answerMode,
          sessionStatus: data.quizStatus,
          stoppedAt: data.stoppedAt,
          nowMs: now(),
        }
      ),
    [data.users, data.submissions, data.userQuizStartTimes, totalQuestions, answerMode, data.quizStatus, data.stoppedAt, clockTick]
  );

  const myFinalRow = useMemo(() => {
    if (!participantId) return null;
    return leaderboardFinal.find((r) => r.participantId === participantId) || null;
  }, [leaderboardFinal, participantId]);

  async function runDbOp(label, operation) {
    try {
      return await operation();
    } catch (err) {
      if (!isPermissionDeniedError(err)) {
        err.dbStep = err.dbStep || label;
        throw err;
      }
      // 匿名登录刚完成时，RTDB 连接可能还没拿到最新 token，重试一次
      await ensureAnonymousAuth(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      try {
        return await operation();
      } catch (err2) {
        err2.dbStep = err2.dbStep || label;
        throw err2;
      }
    }
  }

  function buildSessionPatch(partial) {
    const prev = data.session || buildSessionState(totalQuestions);
    const next = {
      ...prev,
      ...partial,
      answerMode: normalizeAnswerMode(partial.answerMode ?? prev.answerMode),
      totalQuestions,
      updatedAt: now(),
    };
    return {
      session: next,
      quizStatus: next.status,
      answerMode: next.answerMode,
      stoppedAt: next.stoppedAt,
      currentQuestionIndex: next.currentQuestionIndex,
      totalQuestions: next.totalQuestions,
    };
  }

  async function ensureUserQuizStartTime(pid) {
    if (!pid) return 0;
    const existing = Number(data.userQuizStartTimes?.[pid] || 0);
    if (existing > 0) return existing;
    const tx = await runDbOp("写入入场计时", () =>
      runTransaction(ref(db, `/userQuizStartTimes/${pid}`), (cur) => (cur === null ? now() : cur))
    );
    return Number(tx.snapshot.val() || 0);
  }

  async function ensureStartTimeForQuestion(pid, question, startAt) {
    if (!pid) return;
    if (data.quizStatus !== "running") return;
    if (!question) return;

    const qid = question.id;
    const subKey = `${pid}_${qid}`;
    if (data.submissions?.[subKey]) return;

    const stKey = `${pid}_${qid}`;
    if (data.startTimes?.[stKey]) return;
    if (startTimeWriteInFlightRef.current.has(stKey)) return;

    startTimeWriteInFlightRef.current.add(stKey);
    try {
      await runTransaction(ref(db, `/startTimes/${stKey}`), (cur) => (cur === null ? Number(startAt || now()) : cur));
    } catch {
      // ignore: re-sync 后会重试
    } finally {
      startTimeWriteInFlightRef.current.delete(stKey);
    }
  }

  async function ensureStartTimesForParticipant(pid, modeOverride) {
    const targetMode = normalizeAnswerMode(modeOverride ?? answerMode);
    if (targetMode === ANSWER_MODE_ALL) {
      await ensureUserQuizStartTime(pid);
      return;
    }
    await ensureStartTimeForQuestion(pid, currentQuestion);
  }

  // 关键修复：管理员切题后，用户仍在 quiz 页时自动为“新题”写入 startTime
  useEffect(() => {
    if (!authReady) return;
    if (mode !== "participant") return;
    if (participantScreen !== "quiz") return;
    if (!participantId) return;
    ensureStartTimesForParticipant(participantId);
  }, [authReady, mode, participantScreen, participantId, answerMode, data.currentQuestionIndex, data.quizStatus]);

  async function enterQuiz(pid = participantId, modeOverride) {
    setParticipantScreen("quiz");
    await ensureStartTimesForParticipant(pid, modeOverride);
  }

  async function reserveRecoveryCodeUnique() {
    for (let i = 0; i < 12; i++) {
      const code = generateRecoveryCode();
      const tx = await runDbOp("预占恢复码", () =>
        runTransaction(ref(db, `/recoveryCodeIndex/${code}`), (cur) => {
          if (cur === null) return "__RESERVED__";
          return;
        })
      );
      if (tx.committed && tx.snapshot.val() === "__RESERVED__") return code;
    }
    throw new Error("reserve recovery code failed");
  }

  async function register(userNameRaw) {
    try {
      if (!authReady) return { ok: false, message: "连接中，请稍后重试 / Connecting..." };
      const name = normalizeName(userNameRaw);
      const key = normalizeNameKey(name);
      if (!name) return { ok: false, message: "请输入昵称 / Please enter a nickname." };

      const existingPid = data.userNameIndex?.[key];
      if (existingPid) {
        // ✅ 同一设备：允许免恢复码直接进入
        const did = getOrCreateDeviceId();
        const hitPid = data.deviceIndex?.[did];

        if (hitPid === existingPid && data.users?.[existingPid]) {
          const u = data.users[existingPid];

          localStorage.setItem(LS_PARTICIPANT_ID, existingPid);
          setParticipantId(existingPid);
          setUser({ participantId: existingPid, ...u });
          setParticipantScreen("entry");

          return { ok: true, quick: true };
        }

        // ❌ 换设备：仍然要求恢复码
        return { ok: false, message: `昵称已存在：${name}（换设备/清缓存请用恢复码找回；或换昵称）` };
      }

      const pid = generateParticipantId();
      const createdAt = now();
      const did = getOrCreateDeviceId();

      const nameTx = await runDbOp("写入昵称索引", () =>
        runTransaction(ref(db, `/userNameIndex/${key}`), (cur) => (cur === null ? pid : undefined))
      );
      if (!nameTx.committed) return { ok: false, message: `昵称已存在：${name}（可用恢复码找回，或换昵称）` };

      let code;
      try {
        code = await reserveRecoveryCodeUnique();
      } catch {
        await runDbOp("回滚昵称索引", () =>
          runTransaction(ref(db, `/userNameIndex/${key}`), (cur) => (cur === pid ? null : cur))
        );
        return { ok: false, message: "系统繁忙，请重试 / Please retry." };
      }

      const userObj = { userName: name, recoveryCode: code, createdAt };

      await runDbOp("写入用户信息", () => set(ref(db, `/users/${pid}`), userObj));
      await runDbOp("提交恢复码索引", () => set(ref(db, `/recoveryCodeIndex/${code}`), pid));
      await runDbOp("写入设备索引", () => set(ref(db, `/deviceIndex/${did}`), pid));

      localStorage.setItem(LS_PARTICIPANT_ID, pid);
      setParticipantId(pid);
      setUser({ participantId: pid, ...userObj });

      setRecoveryModal({ open: true, code });
      setParticipantScreen("entry");

      return { ok: true };
    } catch (err) {
      console.error("register failed", err);
      return { ok: false, message: toFriendlyError(err, "注册失败，请重试 / Register failed.") };
    }
  }

  async function recoverByCode(codeRaw) {
    try {
      if (!authReady) return { ok: false, message: "连接中，请稍后重试 / Connecting..." };
      const code = normalizeRecoveryCode(codeRaw);
      if (!code) return { ok: false, message: "请输入恢复码 / Please enter recovery code." };

      const pid = data.recoveryCodeIndex?.[code];
      if (!pid) return { ok: false, message: "恢复码无效 / Invalid recovery code." };

      const u = data.users?.[pid];
      if (!u) return { ok: false, message: "用户不存在或已被重置 / User not found." };

      const did = getOrCreateDeviceId();
      await runDbOp("写入设备索引", () => set(ref(db, `/deviceIndex/${did}`), pid));

      localStorage.setItem(LS_PARTICIPANT_ID, pid);
      setParticipantId(pid);
      setUser({ participantId: pid, ...u });
      setParticipantScreen("entry");

      return { ok: true };
    } catch (err) {
      console.error("recover failed", err);
      return { ok: false, message: toFriendlyError(err, "找回失败，请重试 / Recover failed.") };
    }
  }

  async function confirmDeviceEntry() {
    if (!deviceHit) return;
    const pid = deviceHit.participantId;
    const u = data.users?.[pid];
    if (!u) return;

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setUser({ participantId: pid, ...u });
    await enterQuiz(pid);
  }

  async function submitAnswerForQuestion(questionId, answerId) {
    try {
      if (!authReady) return { ok: false, message: "连接中，请稍后重试 / Connecting..." };
      if (!participantId || !user) return { ok: false, message: "未登录 / Not logged in." };
      if (data.quizStatus !== "running") return { ok: false, message: "问卷已关闭 / Closed." };
      const modeNow = normalizeAnswerMode(data.session?.answerMode ?? data.answerMode);
      if (modeNow === ANSWER_MODE_ALL) {
        return { ok: false, message: "全部题模式请在最后统一提交 / Submit all answers at the end." };
      }
      const q = allQuestions.slice(0, totalQuestions).find((item) => item.id === questionId);
      if (!q) return { ok: false, message: "题目不存在 / Question not found." };
      if (!ANSWER_OPTIONS.has(answerId)) return { ok: false, message: "答案无效 / Invalid answer." };

      const key = `${participantId}_${q.id}`;

      const stKey = `${participantId}_${q.id}`;
      let startTime = data.startTimes?.[stKey];

      if (!startTime) {
        const stTx = await runDbOp("写入起始计时", () =>
          runTransaction(ref(db, `/startTimes/${stKey}`), (cur) => (cur === null ? Number(startTime || now()) : cur))
        );
        startTime = stTx.snapshot.val();
      }
      if (!startTime) startTime = now();

      const submitTime = now();
      const duration = Math.max(0, submitTime - startTime);

      const submission = {
        participantId,
        userName: user.userName,
        questionId: q.id,
        answer: answerId,
        isCorrect: answerId === q.correctAnswer,
        startTime,
        submitTime,
        duration,
      };

      const tx = await runDbOp("提交答案", () =>
        runTransaction(ref(db, `/submissions/${key}`), (cur) => (cur === null ? submission : undefined))
      );
      if (!tx.committed) return { ok: false, message: "已提交过 / Already submitted." };
      return { ok: true };
    } catch (err) {
      console.error("submit failed", err);
      return { ok: false, message: toFriendlyError(err, "提交失败，请重试 / Submit failed.") };
    }
  }

  async function submitAnswer(answerId) {
    if (!currentQuestion) return { ok: false, message: "当前无题目 / No question." };
    return submitAnswerForQuestion(currentQuestion.id, answerId);
  }

  async function submitAllAnswers(answersByQid) {
    try {
      if (!authReady) return { ok: false, message: "连接中，请稍后重试 / Connecting..." };
      if (!participantId || !user) return { ok: false, message: "未登录 / Not logged in." };
      if (data.quizStatus !== "running") return { ok: false, message: "问卷已关闭 / Closed." };
      const modeNow = normalizeAnswerMode(data.session?.answerMode ?? data.answerMode);
      if (modeNow !== ANSWER_MODE_ALL) {
        return { ok: false, message: "当前不是全部题模式 / Not in all-questions mode." };
      }

      const questions = allQuestions.slice(0, totalQuestions);
      const normalizedAnswers = {};
      for (const q of questions) {
        const answer = String(answersByQid?.[q.id] || "")
          .trim()
          .toUpperCase();
        if (!ANSWER_OPTIONS.has(answer)) {
          return { ok: false, message: `请先完成全部题目后再提交（Q${q.id} 未作答）` };
        }
        normalizedAnswers[q.id] = answer;
      }

      let entryStart = Number(data.userQuizStartTimes?.[participantId] || 0);
      if (entryStart <= 0) {
        entryStart = await ensureUserQuizStartTime(participantId);
      }
      if (entryStart <= 0) entryStart = now();

      const submitTime = now();
      const duration = Math.max(0, submitTime - entryStart);
      const payloadByKey = {};

      for (const q of questions) {
        const key = `${participantId}_${q.id}`;
        if (data.submissions?.[key]) {
          return { ok: false, message: "你已经提交过全部答案 / Already submitted." };
        }
        payloadByKey[key] = {
          participantId,
          userName: user.userName,
          questionId: q.id,
          answer: normalizedAnswers[q.id],
          isCorrect: normalizedAnswers[q.id] === q.correctAnswer,
          startTime: entryStart,
          submitTime,
          duration,
        };
      }

      await runDbOp("提交全部答案", () => update(ref(db, "/submissions"), payloadByKey));
      return { ok: true };
    } catch (err) {
      const hasAnySubmitted = allQuestions
        .slice(0, totalQuestions)
        .some((q) => data.submissions?.[`${participantId}_${q.id}`]);
      if (hasAnySubmitted && isPermissionDeniedError(err)) {
        return { ok: false, message: "你已经提交过全部答案 / Already submitted." };
      }
      console.error("submit all failed", err);
      return { ok: false, message: toFriendlyError(err, "提交失败，请重试 / Submit failed.") };
    }
  }

  async function doExitFinal() {
    const did = localStorage.getItem(LS_DEVICE_ID);

    localStorage.removeItem(LS_PARTICIPANT_ID);
    sessionStorage.removeItem(SS_IGNORE_DEVICE_HIT);
    setParticipantId("");
    setUser(null);
    setParticipantScreen("entry");
    setMode("participant");

    if (exitClearDevice && did) {
      localStorage.removeItem(LS_DEVICE_ID);
      await runDbOp("清理设备索引", () => set(ref(db, `/deviceIndex/${did}`), null));
    }

    setExitClearDevice(false);
    setExitStep2Open(false);
  }

  async function adminNext() {
    if (!authReady) return;
    if (data.quizStatus !== "running") return;
    const next = Math.min(data.currentQuestionIndex + 1, totalQuestions);
    await update(ref(db, `/`), buildSessionPatch({ currentQuestionIndex: next }));
  }

  async function adminSetAnswerMode(nextMode) {
    if (!authReady) return;
    const mode = normalizeAnswerMode(nextMode);
    await update(ref(db, `/`), buildSessionPatch({ answerMode: mode }));
  }

  async function adminStop() {
    if (!authReady) return;
    const stoppedAt = now();
    await update(ref(db, `/`), buildSessionPatch({ status: "stopped", stoppedAt }));
  }

  async function adminReset() {
    if (!authReady) return;
    if (!window.confirm("确认 Reset？会清空所有用户/提交/索引。")) return;
    await set(ref(db, `/`), buildInitialData(totalQuestions));
  }

  const participantView = useMemo(() => {
    if (mode !== "participant") return null;
    if (isStopped) return { type: "closed" };
    if (isNaturalEnded) return { type: "thanks" };
    if (!user || !participantId) return { type: participantScreen === "auth" ? "auth" : "entry" };
    return { type: participantScreen === "quiz" ? "quiz" : "entry" };
  }, [mode, isStopped, isNaturalEnded, user, participantId, participantScreen]);

  return (
    <div className="app-shell min-h-screen">
      <div className="app-gradient app-gradient-a" />
      <div className="app-gradient app-gradient-b" />
      <div className="app-gradient app-gradient-c" />
      <div className="app-gradient app-gradient-d" />
      <div className="app-noise" />
      <div className="relative z-10">
        <TopBar
          isConnected={isConnected}
          mode={mode}
          user={user}
          themeMode={themeMode}
          resolvedTheme={resolvedTheme}
          onChangeThemeMode={setThemeMode}
          onOpenAdmin={() => setAdminLoginOpen(true)}
          onBackParticipant={() => setMode("participant")}
        />

        {authError ? (
          <div className="mx-auto max-w-6xl px-4 pt-4">
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {authError}
            </div>
          </div>
        ) : null}

        {adminLoginOpen && (
          <AdminLoginModal
            onClose={() => setAdminLoginOpen(false)}
            onSuccess={() => {
              setAdminLoginOpen(false);
              setMode("admin");
            }}
          />
        )}

        {recoveryModal.open && (
          <RecoveryCodeModal
            code={recoveryModal.code}
            onConfirm={async () => {
              setRecoveryModal({ open: false, code: "" });
              await enterQuiz();
            }}
          />
        )}

        {exitStep1Open && (
          <ConfirmModal
            title="确认退出？"
            description="退出将清除本设备参与者身份。跨设备/清缓存需用恢复码找回。"
            confirmText="继续退出"
            cancelText="取消"
            onCancel={() => setExitStep1Open(false)}
            onConfirm={() => {
              setExitStep1Open(false);
              setExitStep2Open(true);
            }}
          />
        )}

        {exitStep2Open && (
          <ExitFinalModal
            code={user?.recoveryCode || ""}
            clearDevice={exitClearDevice}
            onToggleClearDevice={() => setExitClearDevice((v) => !v)}
            onCancel={() => {
              setExitClearDevice(false);
              setExitStep2Open(false);
            }}
            onConfirm={doExitFinal}
          />
        )}

        {mode === "admin" ? (
          <AdminDashboard
            data={data}
            questions={allQuestions}
            leaderboardLive={leaderboardLive}
            leaderboardFinal={leaderboardFinal}
            isInProgress={isInProgress}
            answerMode={answerMode}
            onBack={() => setMode("participant")}
            onSetAnswerMode={adminSetAnswerMode}
            onNext={adminNext}
            onStop={adminStop}
            onReset={adminReset}
          />
        ) : (
          <ParticipantRouter
            view={participantView}
            data={data}
            user={user}
            participantId={participantId}
            deviceHit={deviceHit}
            currentQuestion={currentQuestion}
            totalQuestions={totalQuestions}
            answerMode={answerMode}
            leaderboardFinal={leaderboardFinal}
            myFinalRow={myFinalRow}
            onStart={() => setParticipantScreen("auth")}
            onNotMe={() => {
              sessionStorage.setItem(SS_IGNORE_DEVICE_HIT, "1");
              setDeviceHit(null); 
              setParticipantScreen("auth");
            }}
            onEnterQuiz={enterQuiz}
            onSwitchAccount={() => setParticipantScreen("auth")}
            onConfirmDeviceEntry={confirmDeviceEntry}
            onRegister={register}
            onRecover={recoverByCode}
            onSubmit={submitAnswer}
            onSubmitAll={submitAllAnswers}
            onExit={() => setExitStep1Open(true)}
            onBackToEntry={() => setParticipantScreen("entry")}
          />
        )}
      </div>
    </div>
  );
}

/** ================= UI ================= */

function TopBar({
  isConnected,
  mode,
  user,
  themeMode,
  resolvedTheme,
  onChangeThemeMode,
  onOpenAdmin,
  onBackParticipant,
}) {
  return (
    <div className="topbar-wrap sticky top-3 z-40 px-3 sm:px-4">
      <div className="topbar-glass mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold tracking-wide">Realtime Quiz</div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            {isConnected ? "Online" : "Connecting"}
          </div>
          <span className="hidden rounded-full border border-slate-700/70 bg-white/10 px-2 py-0.5 text-[11px] text-slate-300 sm:inline">
            Theme: {resolvedTheme === THEME_MODE_DARK ? "Dark" : "Light"}
          </span>
          {mode === "admin" && (
            <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300">
              Admin
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-1 rounded-xl border border-slate-700/70 bg-white/10 p-1 sm:flex">
            <button
              onClick={() => onChangeThemeMode(THEME_MODE_AUTO)}
              className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                themeMode === THEME_MODE_AUTO ? "bg-white/20 text-slate-100" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              自动
            </button>
            <button
              onClick={() => onChangeThemeMode(THEME_MODE_LIGHT)}
              className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                themeMode === THEME_MODE_LIGHT ? "bg-white/20 text-slate-100" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              浅色
            </button>
            <button
              onClick={() => onChangeThemeMode(THEME_MODE_DARK)}
              className={`rounded-lg px-2 py-1 text-xs font-semibold ${
                themeMode === THEME_MODE_DARK ? "bg-white/20 text-slate-100" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              深色
            </button>
          </div>
          <select
            value={themeMode}
            onChange={(e) => onChangeThemeMode(normalizeThemeMode(e.target.value))}
            className="rounded-lg border border-slate-700/70 bg-white/10 px-2 py-1 text-xs text-slate-100 outline-none sm:hidden"
          >
            <option value={THEME_MODE_AUTO}>自动</option>
            <option value={THEME_MODE_LIGHT}>浅色</option>
            <option value={THEME_MODE_DARK}>深色</option>
          </select>
          {mode === "admin" ? (
            <button
              onClick={onBackParticipant}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              返回参与者端
            </button>
          ) : (
            <>
              {user ? <div className="hidden sm:block text-sm text-slate-300">{user.userName}</div> : null}
              <button
                onClick={onOpenAdmin}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
              >
                管理员
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ParticipantRouter({
  view,
  data,
  user,
  participantId,
  deviceHit,
  currentQuestion,
  totalQuestions,
  answerMode,
  leaderboardFinal,
  myFinalRow,
  onStart,
  onEnterQuiz,
  onSwitchAccount,
  onConfirmDeviceEntry,
  onRegister,
  onRecover,
  onSubmit,
  onSubmitAll,
  onExit,
  onBackToEntry,
  onNotMe,
}) {
  if (!view) return null;

  if (view.type === "entry") {
    return (
        <EntryPage
          data={data}
          totalQuestions={totalQuestions}
          answerMode={answerMode}
          user={user}
          deviceHit={deviceHit}
          onStart={onStart}
        onEnterQuiz={onEnterQuiz}
        onSwitchAccount={onSwitchAccount}
        onConfirmDeviceEntry={onConfirmDeviceEntry}
        onExit={onExit}
        onNotMe={onNotMe}
      />
    );
  }

  if (view.type === "auth") {
    return <AuthPage onBack={onBackToEntry} onRegister={onRegister} onRecover={onRecover} />;
  }

  if (view.type === "quiz") {
    if (answerMode === ANSWER_MODE_ALL) {
      return (
        <QuizAllPage
          data={data}
          participantId={participantId}
          user={user}
          questions={allQuestions.slice(0, totalQuestions)}
          onSubmitAll={onSubmitAll}
          onExit={onExit}
        />
      );
    }
    return (
      <QuizPage
        data={data}
        participantId={participantId}
        user={user}
        currentQuestion={currentQuestion}
        totalQuestions={totalQuestions}
        onSubmit={onSubmit}
        onExit={onExit}
      />
    );
  }

  if (view.type === "thanks") {
    return (
      <EndPage
        kind="thanks"
        answerMode={answerMode}
        leaderboard={leaderboardFinal}
        myRow={myFinalRow}
        totalQuestions={totalQuestions}
        onExit={onExit}
      />
    );
  }

  if (view.type === "closed") {
    return (
      <EndPage
        kind="closed"
        answerMode={answerMode}
        leaderboard={leaderboardFinal}
        myRow={myFinalRow}
        totalQuestions={totalQuestions}
        onExit={onExit}
      />
    );
  }

  return null;
}

function EntryPage({
  data,
  totalQuestions,
  answerMode,
  user,
  deviceHit,
  onStart,
  onNotMe,
  onEnterQuiz,
  onSwitchAccount,
  onConfirmDeviceEntry,
  onExit,
}) {
  const isSingleMode = normalizeAnswerMode(answerMode) === ANSWER_MODE_SINGLE;
  const statusText =
    data.quizStatus === "stopped"
      ? "问卷已关闭 / Closed"
      : isSingleMode && data.currentQuestionIndex >= totalQuestions
      ? "已完成 / Finished"
      : "进行中 / Running";

  return (
    <div className="page-stage mx-auto max-w-3xl px-3 py-6 sm:px-4 sm:py-10">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">参与答题</h1>
            <p className="mt-1 text-sm text-slate-400">状态：{statusText}</p>
          </div>

          {(user || deviceHit) ? (
            <button
              onClick={onExit}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              退出
            </button>
          ) : null}
        </div>

        <div className="mt-6 space-y-2 text-sm text-slate-300">
          <div>计时起点：进入答题页后才开始（新用户需先确认保存恢复码）。</div>
          <div>
            {isSingleMode
              ? "进行中榜单：仅累计已作答耗时；结束/Stop 后才加未答 120s/题惩罚。"
              : "全部题模式：总时长=进入答题页到全部完成/管理员 Stop，不按单题耗时统计。"}
          </div>
        </div>

        {user ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm text-slate-200">
              欢迎回来：<span className="font-semibold">{user.userName}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={onEnterQuiz}
                className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500"
              >
                继续进入
              </button>
              <button
                onClick={onSwitchAccount}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-200 hover:bg-slate-800"
              >
                切换账号
              </button>
            </div>
          </div>
        ) : deviceHit ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm text-slate-200">
              检测到你可能是：<span className="font-semibold">{deviceHit.userName}</span>，直接进入？
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={onConfirmDeviceEntry}
                className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500"
              >
                继续进入
              </button>
              <button
                onClick={onNotMe}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-200 hover:bg-slate-800"
              >
                不是我（切换账号）
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <button
              onClick={onStart}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-500"
            >
              参与答题 / Start
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AuthPage({ onBack, onRegister, onRecover }) {
  const [tab, setTab] = useState("register");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function doRegister() {
    setMsg("");
    setBusy(true);
    try {
      const res = await onRegister(name);
      if (!res.ok) setMsg(res.message || "注册失败");
    } catch (err) {
      setMsg(toFriendlyError(err, "注册失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  async function doRecover() {
    setMsg("");
    setBusy(true);
    try {
      const res = await onRecover(code);
      if (!res.ok) setMsg(res.message || "找回失败");
    } catch (err) {
      setMsg(toFriendlyError(err, "找回失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stage mx-auto max-w-lg px-3 py-6 sm:px-4 sm:py-10">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">注册 / 找回</h2>
        <button
          onClick={onBack}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          ← 返回
        </button>
      </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setTab("register")}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === "register" ? "bg-indigo-600" : "border border-slate-700 bg-slate-900 hover:bg-slate-800"
            }`}
          >
            注册
          </button>
          <button
            onClick={() => setTab("recover")}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
              tab === "recover" ? "bg-indigo-600" : "border border-slate-700 bg-slate-900 hover:bg-slate-800"
            }`}
          >
            用恢复码找回
          </button>
        </div>

        {tab === "register" ? (
          <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">新用户注册（昵称全局唯一）</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500"
              placeholder="输入昵称"
              autoComplete="off"
            />
            <button
              disabled={busy || !normalizeName(name)}
              onClick={doRegister}
              className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 font-semibold disabled:opacity-50"
            >
              注册
            </button>
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">跨设备/清缓存：用恢复码找回</div>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-slate-100 outline-none focus:border-indigo-500"
              placeholder="例如：A2BC9D"
              autoComplete="off"
            />
            <button
              disabled={busy || !normalizeRecoveryCode(code)}
              onClick={doRecover}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50"
            >
              找回并进入
            </button>
          </div>
        )}

        {msg ? (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {msg}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuizPage({ data, participantId, user, currentQuestion, totalQuestions, onSubmit, onExit }) {
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const qid = currentQuestion?.id;
  const subKey = participantId && qid ? `${participantId}_${qid}` : "";
  const submission = subKey ? data.submissions?.[subKey] : null;
  const hasSubmitted = !!submission;

  const stKey = participantId && qid ? `${participantId}_${qid}` : "";
  const startTime = stKey ? data.startTimes?.[stKey] : null;

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setSelected(null);
    setErr("");
    setElapsed(0);
  }, [data.currentQuestionIndex, participantId]);

  useEffect(() => {
    if (!startTime || hasSubmitted) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.max(0, now() - startTime));
    const t = setInterval(() => setElapsed(Math.max(0, now() - startTime)), 100);
    return () => clearInterval(t);
  }, [startTime, hasSubmitted, qid]);

  async function doSubmit() {
    if (!selected) return;
    setErr("");
    setBusy(true);
    try {
      const res = await onSubmit(selected);
      if (!res.ok) setErr(res.message || "提交失败");
    } catch (err) {
      setErr(toFriendlyError(err, "提交失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stage mx-auto max-w-3xl px-3 py-6 sm:px-4 sm:py-10">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm text-slate-300">
          用户：<span className="font-semibold">{user?.userName || "-"}</span>
        </div>
        <button
          onClick={onExit}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          退出
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold text-slate-400">
              QUESTION {data.currentQuestionIndex + 1} / {totalQuestions}
            </div>
            <h2 className="mt-2 whitespace-pre-line text-xl font-bold">{currentQuestion?.question || "无题目"}</h2>
          </div>

          {!hasSubmitted ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-right">
              <div className="text-xs text-slate-400">用时</div>
              <div className="font-mono text-lg font-semibold text-amber-300">{formatMs(startTime ? elapsed : 0)}</div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-right">
              <div className="text-xs text-slate-400">已提交</div>
              <div className="font-mono text-lg font-semibold text-slate-200">{formatMs(submission.duration)}</div>
            </div>
          )}
        </div>

        <div className="mt-6 grid gap-3">
          {(currentQuestion?.options || []).map((opt) => {
            const isPicked = selected === opt.id;
            const isMyAnswer = submission?.answer === opt.id;

            let cls = "w-full rounded-xl border px-4 py-3 text-left transition ";
            if (hasSubmitted) {
              if (isMyAnswer) {
                cls += submission.isCorrect
                  ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
                  : "border-red-500/60 bg-red-500/10 text-red-200";
              } else {
                cls += "border-slate-800 bg-slate-950 text-slate-400";
              }
            } else {
              cls += isPicked
                ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                : "border-slate-800 bg-slate-950 text-slate-200 hover:bg-slate-900";
            }

            return (
              <button key={opt.id} disabled={hasSubmitted} onClick={() => setSelected(opt.id)} className={cls}>
                <span className="mr-3 inline-flex h-6 w-6 items-center justify-center rounded-md border border-current/40 font-mono text-xs">
                  {opt.id}
                </span>
                {opt.text}
              </button>
            );
          })}
        </div>

        {err ? (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}

        <div className="mt-6">
          {data.quizStatus !== "running" ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-300">
              问卷已关闭，无法提交。
            </div>
          ) : hasSubmitted ? (
            <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 ring-1 ring-emerald-500/20">
              <div className="font-semibold">已提交</div>
              <div className="mt-1 text-emerald-200/90">请等待下一题刷新。</div>
            </div>
          ) : (
            <button
              disabled={!selected || busy}
              onClick={doSubmit}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold disabled:opacity-50"
            >
              {busy ? "提交中..." : "提交"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function QuizAllPage({ data, participantId, user, questions, onSubmitAll, onExit }) {
  const [selectedByQid, setSelectedByQid] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setSelectedByQid({});
    setBusy(false);
    setErr("");
  }, [participantId]);

  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 100);
    return () => clearInterval(timer);
  }, []);

  const currentNow = useMemo(() => now(), [tick]);
  const entryStart = Number(data.userQuizStartTimes?.[participantId] || 0);
  const userSubs = useMemo(() => {
    const map = {};
    for (const q of questions) {
      const key = `${participantId}_${q.id}`;
      const s = data.submissions?.[key];
      if (s) map[q.id] = s;
    }
    return map;
  }, [participantId, questions, data.submissions]);

  const submittedCount = useMemo(() => Object.keys(userSubs).length, [userSubs]);
  const isSubmittedAll = useMemo(
    () => questions.length > 0 && questions.every((q) => !!userSubs[q.id]),
    [questions, userSubs]
  );
  const latestSubmitTime = useMemo(
    () => Object.values(userSubs).reduce((max, s) => Math.max(max, Number(s.submitTime || 0)), 0),
    [userSubs]
  );
  const stopAt = Number(data.stoppedAt || 0);
  const endTime = isSubmittedAll
    ? latestSubmitTime
    : data.quizStatus === "stopped" && stopAt > 0
    ? stopAt
    : currentNow;
  const totalElapsed = entryStart > 0 ? Math.max(0, endTime - entryStart) : 0;

  const selectedCount = useMemo(
    () => questions.reduce((acc, q) => (selectedByQid[q.id] ? acc + 1 : acc), 0),
    [questions, selectedByQid]
  );
  const missingQuestions = useMemo(
    () => questions.filter((q) => !selectedByQid[q.id]).map((q) => q.id),
    [questions, selectedByQid]
  );

  useEffect(() => {
    if (!isSubmittedAll) return;
    const fromDb = {};
    for (const q of questions) {
      fromDb[q.id] = userSubs[q.id]?.answer || "";
    }
    setSelectedByQid(fromDb);
  }, [isSubmittedAll, questions, userSubs]);

  async function submitAllAtOnce() {
    if (busy || isSubmittedAll) return;
    if (data.quizStatus !== "running") {
      setErr("问卷已关闭，无法提交。");
      return;
    }
    if (missingQuestions.length > 0) {
      setErr(`请先完成全部题目后再提交（缺少 Q${missingQuestions.join(", Q")}）`);
      return;
    }

    setErr("");
    setBusy(true);
    try {
      const res = await onSubmitAll(selectedByQid);
      if (!res.ok) setErr(res.message || "提交失败");
    } catch (error) {
      setErr(toFriendlyError(error, "提交失败，请稍后重试"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stage mx-auto max-w-5xl px-3 py-6 sm:px-4 sm:py-10">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm text-slate-300">
          用户：<span className="font-semibold">{user?.userName || "-"}</span>
        </div>
        <button
          onClick={onExit}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          退出
        </button>
      </div>

      <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">总计时（全部题模式）</div>
            <div className="mt-1 text-xs text-slate-400">从进入答题页开始，到你点击“提交全部答案”或管理员 Stop 为止。</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-right">
            <div className="text-xs text-slate-400">Total Elapsed</div>
            <div className="font-mono text-2xl font-semibold text-amber-300">{formatMs(totalElapsed)}</div>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-300">
          已选择：{selectedCount}/{questions.length} · 已提交：{submittedCount}/{questions.length}
        </div>
      </div>

      <div className="space-y-4">
        {questions.map((q, idx) => {
          const submission = userSubs[q.id];
          const hasSubmitted = !!submission;
          const selected = selectedByQid[q.id] || "";
          const isLocked = hasSubmitted || isSubmittedAll || data.quizStatus !== "running";

          return (
            <div key={q.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold text-slate-400">
                    QUESTION {idx + 1} / {questions.length}
                  </div>
                  <h2 className="mt-2 whitespace-pre-line text-xl font-bold">{q.question}</h2>
                </div>
                <div
                  className={`rounded-xl border px-4 py-2 text-right text-sm font-semibold ${
                    hasSubmitted
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                      : selected
                      ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200"
                      : "border-slate-800 bg-slate-950 text-slate-300"
                  }`}
                >
                  {hasSubmitted ? `已提交 ${submission.answer}` : selected ? `已选 ${selected}` : "未选择"}
                </div>
              </div>

              <div className="mt-6 grid gap-3">
                {q.options.map((opt) => {
                  const isPicked = selected === opt.id;
                  const isMyAnswer = submission?.answer === opt.id;

                  let cls = "w-full rounded-xl border px-4 py-3 text-left transition ";
                  if (hasSubmitted) {
                    if (isMyAnswer) {
                      cls += submission.isCorrect
                        ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
                        : "border-red-500/60 bg-red-500/10 text-red-200";
                    } else {
                      cls += "border-slate-800 bg-slate-950 text-slate-400";
                    }
                  } else {
                    cls += isPicked
                      ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-200"
                      : "border-slate-800 bg-slate-950 text-slate-200 hover:bg-slate-900";
                  }

                  return (
                    <button
                      key={opt.id}
                      disabled={isLocked}
                      onClick={() => {
                        setSelectedByQid((prev) => ({ ...prev, [q.id]: opt.id }));
                        setErr("");
                      }}
                      className={cls}
                    >
                      <span className="mr-3 inline-flex h-6 w-6 items-center justify-center rounded-md border border-current/40 font-mono text-xs">
                        {opt.id}
                      </span>
                      {opt.text}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        {err ? (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {err}
          </div>
        ) : null}
        {data.quizStatus !== "running" ? (
          <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-300">
            问卷已关闭，无法提交。
          </div>
        ) : isSubmittedAll ? (
          <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 ring-1 ring-emerald-500/20">
            <div className="font-semibold">已完成提交</div>
            <div className="mt-1 text-emerald-200/90">全部答案已提交，等待结束即可。</div>
          </div>
        ) : (
          <button
            disabled={busy || missingQuestions.length > 0}
            onClick={submitAllAtOnce}
            className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold disabled:opacity-50"
          >
            {busy ? "提交中..." : `提交全部答案（${selectedCount}/${questions.length}）`}
          </button>
        )}
      </div>
    </div>
  );
}

function EndPage({ kind, answerMode, leaderboard, myRow, totalQuestions, onExit }) {
  const title = kind === "closed" ? "问卷已关闭" : "谢谢参与";
  const isSingleMode = normalizeAnswerMode(answerMode) === ANSWER_MODE_SINGLE;
  const desc = isSingleMode
    ? "最终榜单：正确率↓，总耗时↑（未作答每题 +120s）。"
    : "最终榜单：正确率↓，总耗时↑（从进入答题页到完成/Stop 的总时长）。";

  return (
    <div className="page-stage mx-auto max-w-5xl px-3 py-6 sm:px-4 sm:py-10">
      <div className="mb-4 flex items-center justify-end">
        <button
          onClick={onExit}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          退出
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <h2 className="text-2xl font-bold">{title}</h2>
        <p className="mt-2 text-sm text-slate-400">{desc}</p>
        <div className="mt-6">{myRow ? <MyStats myRow={myRow} totalQuestions={totalQuestions} /> : null}</div>
      </div>

      <div className="mt-6">
        <LeaderboardTable leaderboard={leaderboard} totalQuestions={totalQuestions} />
      </div>
    </div>
  );
}

function MyStats({ myRow, totalQuestions }) {
  const accPct = Math.round(myRow.accuracy * 100);
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <StatCard label="排名 Rank" value={`${myRow.rank}`} />
      <StatCard label="正确 Correct" value={`${myRow.correctCount}/${totalQuestions}`} />
      <StatCard label="正确率 Accuracy" value={`${accPct}%`} />
      <StatCard label="总耗时 Total Time" value={formatMs(myRow.totalTime)} mono />
    </div>
  );
}

function StatCard({ label, value, mono }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function LeaderboardTable({ leaderboard, totalQuestions }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-lg font-bold">最终排行榜 Final Leaderboard</h3>
        <div className="text-xs text-slate-400 text-right">排序：正确率↓，总耗时↑（未作答每题 +120s）</div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-slate-300">
              <th className="py-2 pr-3">Rank</th>
              <th className="py-2 pr-3">User</th>
              <th className="py-2 pr-3">Correct</th>
              <th className="py-2 pr-3">Accuracy</th>
              <th className="py-2 pr-3">Answered</th>
              <th className="py-2 pr-3">Unanswered</th>
              <th className="py-2 pr-3">Total Time</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              leaderboard.map((r) => (
                <tr key={r.participantId} className="border-b border-slate-800/60">
                  <td className="py-2 pr-3 font-mono">{r.rank}</td>
                  <td className="py-2 pr-3 font-semibold">{r.userName}</td>
                  <td className="py-2 pr-3">
                    {r.correctCount}/{totalQuestions}
                  </td>
                  <td className="py-2 pr-3">{Math.round(r.accuracy * 100)}%</td>
                  <td className="py-2 pr-3">{r.answeredCount}</td>
                  <td className="py-2 pr-3">{r.unansweredCount}</td>
                  <td className="py-2 pr-3 font-mono">{formatMs(r.totalTime)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** ================= Admin ================= */

function AdminDashboard({
  data,
  questions,
  leaderboardLive,
  leaderboardFinal,
  isInProgress,
  answerMode,
  onBack,
  onSetAnswerMode,
  onNext,
  onStop,
  onReset,
}) {
  const totalQuestions = questions.length;
  const isSingleMode = normalizeAnswerMode(answerMode) === ANSWER_MODE_SINGLE;
  const currentQ =
    isSingleMode && data.currentQuestionIndex >= 0 && data.currentQuestionIndex < totalQuestions
      ? questions[data.currentQuestionIndex]
      : null;

  const currentSubs = useMemo(() => {
    if (!isSingleMode || !currentQ) return [];
    const obj = data.submissions || {};
    const list = Object.values(obj).filter((s) => s.questionId === currentQ.id);
    list.sort((a, b) => (a.submitTime || 0) - (b.submitTime || 0));
    return list;
  }, [data.submissions, isSingleMode, currentQ]);

  const allModeRows = useMemo(() => {
    const questionIds = questions.map((q) => q.id);
    const questionIdSet = new Set(questionIds);
    const byUser = new Map();

    for (const submission of Object.values(data.submissions || {})) {
      const qid = Number(submission.questionId || 0);
      if (!questionIdSet.has(qid)) continue;
      const pid = String(submission.participantId || "");
      if (!pid) continue;

      if (!byUser.has(pid)) {
        byUser.set(pid, {
          participantId: pid,
          userName: submission.userName || data.users?.[pid]?.userName || pid,
          totalTime: Number(submission.duration || 0),
          lastSubmitTime: Number(submission.submitTime || 0),
          answersByQid: {},
        });
      }

      const row = byUser.get(pid);
      row.totalTime = Math.max(row.totalTime, Number(submission.duration || 0));
      row.lastSubmitTime = Math.max(row.lastSubmitTime, Number(submission.submitTime || 0));
      row.answersByQid[qid] = { answer: submission.answer || "-", isCorrect: !!submission.isCorrect };
    }

    const rows = Array.from(byUser.values()).map((row) => {
      const answeredCount = Object.keys(row.answersByQid).length;
      return {
        ...row,
        answeredCount,
        isComplete: answeredCount === questionIds.length,
      };
    });

    rows.sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
      if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
      return a.lastSubmitTime - b.lastSubmitTime;
    });

    let rank = 0;
    return rows.map((row) => {
      if (row.isComplete) rank += 1;
      return {
        ...row,
        rank: row.isComplete ? rank : null,
      };
    });
  }, [data.submissions, data.users, questions]);

  const isNaturalEnded = data.quizStatus === "running" && isSingleMode && data.currentQuestionIndex >= totalQuestions;
  const showLeaderboard = isInProgress ? leaderboardLive : leaderboardFinal;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={onBack}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          ← 返回参与者端
        </button>

        <span
          className={`rounded-full border px-2 py-0.5 text-xs ${
            data.quizStatus === "stopped"
              ? "border-red-500/50 bg-red-500/10 text-red-200"
              : isNaturalEnded
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
              : "border-indigo-500/50 bg-indigo-500/10 text-indigo-200"
          }`}
        >
          {data.quizStatus === "stopped" ? "STOPPED" : isNaturalEnded ? "FINISHED" : "RUNNING"}
        </span>
      </div>

      <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="text-sm font-semibold">答题模式</div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <button
            onClick={() => onSetAnswerMode(ANSWER_MODE_SINGLE)}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${
              isSingleMode ? "bg-indigo-600 text-white" : "border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            }`}
          >
            逐题控制
          </button>
          <button
            onClick={() => onSetAnswerMode(ANSWER_MODE_ALL)}
            className={`rounded-xl px-3 py-2 text-sm font-semibold ${
              !isSingleMode ? "bg-indigo-600 text-white" : "border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            }`}
          >
            全部题目直接展示
          </button>
        </div>
        <div className="mt-2 text-xs text-slate-400">
          逐题模式由管理员手动切题；全部题目模式下，参与者进入后可直接看到并提交所有题目。
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-slate-400">{isSingleMode ? "当前题目 Current" : "当前模式 Current Mode"}</div>
              <div className="mt-1 text-lg font-bold">
                {isSingleMode ? (currentQ ? `Q${currentQ.id}` : "已无题目（自然结束）") : "全部题目直接展示"}
              </div>
              {isSingleMode ? (
                currentQ ? (
                  <>
                    <div className="mt-2 whitespace-pre-line text-sm text-slate-200">{currentQ.question}</div>
                    <div className="mt-3 text-sm text-emerald-300">
                      正确答案 Answer: <span className="font-mono">{currentQ.correctAnswer}</span>
                    </div>
                  </>
                ) : (
                  <div className="mt-2 text-sm text-slate-400">currentQuestionIndex ≥ totalQuestions</div>
                )
              ) : (
                <div className="mt-2 text-sm text-slate-300">该模式下无需点击“下一题”，参与者可在一个页面完成全部题目。</div>
              )}
            </div>

            <div className="flex gap-2">
              {isSingleMode ? (
                <button
                  disabled={data.quizStatus !== "running" || data.currentQuestionIndex >= totalQuestions}
                  onClick={onNext}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
                >
                  下一题 Next
                </button>
              ) : (
                <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300">全部模式无需切题</div>
              )}
              <button
                onClick={onStop}
                className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-200 hover:bg-red-500/15"
              >
                Stop
              </button>
              <button
                onClick={onReset}
                className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">{isSingleMode ? "本题实时提交" : "提交名次（全部题目）"}</div>
              <div className="text-xs text-slate-400">
                {isSingleMode ? "不展示提交时间点，仅看耗时/对错" : "每位用户仅展示一行：答案/对错 + 总耗时（越小名次越高）"}
              </div>
            </div>

            {isSingleMode ? (
              currentQ ? (
                currentSubs.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">暂无提交</div>
                ) : (
                  <div className="mt-3 divide-y divide-slate-800">
                    {currentSubs.map((s, i) => (
                      <div key={`${s.participantId}_${s.questionId}`} className="flex items-center justify-between py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 font-mono text-xs text-slate-200">
                            {i + 1}
                          </div>
                          <div>
                            <div className="font-semibold">{s.userName}</div>
                            <div className="text-xs text-slate-400">
                              Selected: <span className="font-mono text-slate-200">{s.answer}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="font-mono text-lg font-semibold text-indigo-200">{formatMs(s.duration)}</div>
                          <div
                            className={`rounded-full border px-2 py-0.5 text-xs ${
                              s.isCorrect
                                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                                : "border-red-500/50 bg-red-500/10 text-red-200"
                            }`}
                          >
                            {s.isCorrect ? "Correct" : "Wrong"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="py-6 text-sm text-slate-400">当前无题目。</div>
              )
            ) : allModeRows.length === 0 ? (
              <div className="py-6 text-sm text-slate-400">暂无提交。</div>
            ) : (
              <div className="mt-3 space-y-3">
                {allModeRows.map((row) => (
                  <div key={row.participantId} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 font-mono text-xs text-slate-200">
                          {row.rank ?? "-"}
                        </div>
                        <div>
                          <div className="font-semibold">
                            {row.userName}
                            {!row.isComplete ? <span className="ml-2 text-xs text-amber-300">未完成</span> : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {questions.map((q) => {
                              const ans = row.answersByQid[q.id];
                              if (!ans) {
                                return (
                                  <span
                                    key={`${row.participantId}_${q.id}`}
                                    className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-400"
                                  >
                                    Q{q.id}: -
                                  </span>
                                );
                              }
                              return (
                                <span
                                  key={`${row.participantId}_${q.id}`}
                                  className={`rounded-full border px-2 py-0.5 text-xs ${
                                    ans.isCorrect
                                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                                      : "border-red-500/50 bg-red-500/10 text-red-200"
                                  }`}
                                >
                                  Q{q.id}: {ans.answer} · {ans.isCorrect ? "对" : "错"}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <div className="min-w-[96px] text-right">
                        <div className="text-xs text-slate-400">总耗时</div>
                        <div className="font-mono text-lg font-semibold text-indigo-200">{formatMs(row.totalTime)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-sm font-semibold">完整题库（含答案）</div>
          <div className="mt-2 text-xs text-slate-400">{isSingleMode ? "当前题高亮" : "全部题目模式：不区分当前题"}</div>
          <div className="admin-library-shell mt-4 p-2">
            <div className="max-h-[560px] overflow-auto pr-1">
              <div className="space-y-3 px-1 pb-1">
              {questions.map((q, idx) => (
                <div
                  key={q.id}
                  className={`rounded-xl border p-3 ${
                    isSingleMode && idx === data.currentQuestionIndex
                      ? "border-indigo-500/60 bg-indigo-500/10"
                      : "border-slate-800 bg-slate-950"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">Q{q.id}</div>
                    <div className="text-xs text-emerald-300">
                      Ans: <span className="font-mono">{q.correctAnswer}</span>
                    </div>
                  </div>
                  <div className="mt-2 whitespace-pre-line text-xs text-slate-200">{q.question}</div>
                </div>
              ))}
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
                {isSingleMode
                  ? "进行中排行榜：只累计已答耗时（liveTime）；结束/Stop 才加未答惩罚形成 finalTime"
                  : "全部题模式排行榜：统计进入答题页到全部完成/管理员 Stop 的总时长（不按单题计时）"}
              </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <AdminLeaderboardTable
          leaderboard={showLeaderboard}
          totalQuestions={totalQuestions}
          variant={isInProgress ? "live" : "final"}
          answerMode={answerMode}
        />
      </div>
    </div>
  );
}

function AdminLeaderboardTable({ leaderboard, totalQuestions, variant, answerMode }) {
  const isLive = variant === "live";
  const isSingleMode = normalizeAnswerMode(answerMode) === ANSWER_MODE_SINGLE;
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-lg font-bold">排行榜 Leaderboard</h3>
        <div className="text-xs text-slate-400 text-right">
          {isSingleMode
            ? isLive
              ? "进行中：liveTime（仅已答累计耗时）"
              : "最终：finalTime（含未答120s/题惩罚）"
            : "全部题模式：totalTime（进入答题页到完成/Stop）"}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-left text-slate-300">
              <th className="py-2 pr-3">Rank</th>
              <th className="py-2 pr-3">User</th>
              <th className="py-2 pr-3">Correct</th>
              <th className="py-2 pr-3">Accuracy</th>
              <th className="py-2 pr-3">Answered</th>
              <th className="py-2 pr-3">Unanswered</th>
              <th className="py-2 pr-3">{isLive ? "Live Time" : "Final Time"}</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            ) : (
              leaderboard.map((r) => (
                <tr key={r.participantId} className="border-b border-slate-800/60">
                  <td className="py-2 pr-3 font-mono">{r.rank}</td>
                  <td className="py-2 pr-3 font-semibold">{r.userName}</td>
                  <td className="py-2 pr-3">
                    {r.correctCount}/{totalQuestions}
                  </td>
                  <td className="py-2 pr-3">{Math.round(r.accuracy * 100)}%</td>
                  <td className="py-2 pr-3">{r.answeredCount}</td>
                  <td className="py-2 pr-3">{r.unansweredCount}</td>
                  <td className="py-2 pr-3 font-mono">{formatMs(isLive ? r.liveTime : r.totalTime)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** ================= Modals ================= */

function AdminLoginModal({ onClose, onSuccess }) {
  const [pwd, setPwd] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    if (pwd === ADMIN_PASSWORD) onSuccess();
    else setErr("密码错误 / Wrong password.");
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="text-lg font-bold">管理员登录</div>
        <div className="mt-3">
          <input
            type="password"
            value={pwd}
            onChange={(e) => {
              setPwd(e.target.value);
              setErr("");
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500"
            placeholder="Password"
            autoFocus
          />
        </div>

        {err ? (
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</div>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            取消
          </button>
          <button
            onClick={submit}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            登录
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function RecoveryCodeModal({ code, onConfirm }) {
  const [copied, setCopied] = useState(false);

  async function doCopy() {
    const ok = await copyToClipboard(code);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <ModalShell onClose={null}>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="text-lg font-bold">保存你的恢复码</div>
        <div className="mt-2 text-sm text-slate-400">
          换设备或清缓存后用它找回身份（每人一个，固定不变）。
          <br />
          点击“我已保存”后才进入答题并开始计时。
        </div>

        <div className="mt-4 rounded-xl border border-indigo-500/30 bg-slate-950 p-4 text-center">
          <div className="select-all font-mono text-3xl font-bold tracking-widest text-indigo-200">{code}</div>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={doCopy}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            我已保存
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ConfirmModal({ title, description, confirmText, cancelText, onConfirm, onCancel }) {
  return (
    <ModalShell onClose={onCancel}>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="text-lg font-bold">{title}</div>
        <div className="mt-2 text-sm text-slate-400">{description}</div>
        <div className="mt-5 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ExitFinalModal({ code, clearDevice, onToggleClearDevice, onCancel, onConfirm }) {
  const [copied, setCopied] = useState(false);

  async function doCopy() {
    const ok = await copyToClipboard(code);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <ModalShell onClose={onCancel}>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="text-lg font-bold">退出前请保存恢复码</div>
        <div className="mt-2 text-sm text-slate-400">退出会清除本机身份；恢复需要恢复码。</div>

        <div className="mt-4 rounded-xl border border-indigo-500/30 bg-slate-950 p-4 text-center">
          <div className="select-all font-mono text-3xl font-bold tracking-widest text-indigo-200">{code || "-"}</div>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            onClick={doCopy}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            {copied ? "已复制" : "复制"}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            取消
          </button>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-200">
          <input type="checkbox" checked={clearDevice} onChange={onToggleClearDevice} />
          同时清除本设备识别（不再自动识别）
        </label>

        <button
          onClick={onConfirm}
          className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
        >
          我已保存并退出
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md">
        {onClose ? (
          <button
            onClick={onClose}
            className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            aria-label="Close"
          >
            ×
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

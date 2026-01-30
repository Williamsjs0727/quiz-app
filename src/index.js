import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ref, onValue, set, update, runTransaction } from "firebase/database";
import { db } from "./firebase";

/**
 * Realtime Quiz App
 * Implemented:
 * - 计时只在“进入答题”后开始（新用户点“我已保存，进入”；老用户点“直接进入”）
 * - 昵称已存在：弹窗提示“是否检测到本机就是该用户：一键进入 / 否则用恢复码”
 * - 首页检测到本机用户：显示“欢迎回来 + 直接进入”
 * - 管理员排行榜：进行中=累计已作答耗时；结束/stop=加未作答120s惩罚后的总耗时
 * - 退出两次确认，第二次展示恢复码
 */

const ADMIN_PASSWORD = "ennebei";
const LS_PARTICIPANT_ID = "quiz_participant_id";
const UNANSWERED_PENALTY_MS = 120000;

// ===== Question Bank =====
const allQuestions = [
  {
    id: 1,
    question:
      "以下哪个是 JavaScript 的原始数据类型？\nWhich of the following is a primitive data type in JavaScript?",
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
    question:
      "React 中，以下哪个 Hook 用于处理副作用？\nIn React, which Hook is used to handle side effects?",
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
      { id: "A", text: "服务器错误 Server Error" },
      { id: "B", text: "请求成功 Request Successful" },
      { id: "C", text: "资源未找到 Resource Not Found" },
      { id: "D", text: "重定向 Redirect" },
    ],
    correctAnswer: "C",
  },
  {
    id: 4,
    question:
      "CSS 中，哪个属性用于设置弹性布局？\nIn CSS, which property is used to set flex layout?",
    options: [
      { id: "A", text: "display: block" },
      { id: "B", text: "display: flex" },
      { id: "C", text: "display: grid" },
      { id: "D", text: "display: inline" },
    ],
    correctAnswer: "B",
  },
];

// ===== Utils =====
function now() {
  return Date.now();
}
function generateId() {
  return now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function generateRecoveryCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function normalizeName(name) {
  return (name || "").trim();
}
function normalizeNameKey(name) {
  return normalizeName(name).toLowerCase();
}
function normalizeRecoveryCode(code) {
  return (code || "").trim().toUpperCase();
}
function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const s = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${s}.${d}s`;
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

// ===== DB initial data =====
const initialData = {
  quizStatus: "running",
  stoppedAt: null,
  currentQuestionIndex: 0,

  users: {}, // {participantId:{userName,recoveryCode,createdAt}}
  userNameIndex: {}, // {lowerName: participantId}
  recoveryCodeIndex: {}, // {recoveryCode: participantId}

  startTimes: {}, // {pid_qid: startTimeMs}
  submissions: {}, // {pid_qid: submission}
};

// ===== Leaderboard computation =====
function computeLeaderboard({ users, submissions }, totalQuestions, { includePenalty }) {
  const userEntries = Object.entries(users || {}).map(([participantId, u]) => ({
    participantId,
    userName: u.userName,
    createdAt: u.createdAt || 0,
  }));

  const byKey = submissions || {};
  const questions = allQuestions.slice(0, totalQuestions);

  const rows = userEntries.map((u) => {
    let answeredCount = 0;
    let correctCount = 0;
    let answeredTime = 0;

    for (const q of questions) {
      const key = `${u.participantId}_${q.id}`;
      const sub = byKey[key];
      if (sub) {
        answeredCount += 1;
        answeredTime += Number(sub.duration || 0);
        if (sub.isCorrect) correctCount += 1;
      }
    }

    const unansweredCount = totalQuestions - answeredCount;
    const penaltyTime = includePenalty ? unansweredCount * UNANSWERED_PENALTY_MS : 0;
    const totalTime = answeredTime + penaltyTime;
    const accuracy = totalQuestions > 0 ? correctCount / totalQuestions : 0;

    return {
      participantId: u.participantId,
      userName: u.userName,
      createdAt: u.createdAt,
      answeredCount,
      unansweredCount,
      correctCount,
      accuracy,
      answeredTime,
      penaltyTime,
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
  return rows.map((r, idx) => {
    const k = `${r.accuracy}-${r.totalTime}`;
    if (k !== lastKey) {
      rank = idx + 1;
      lastKey = k;
    }
    return { ...r, rank };
  });
}

// ===== App =====
function App() {
  const totalQuestions = allQuestions.length;

  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);

  const [mode, setMode] = useState("participant"); // participant | admin
  const [participantId, setParticipantId] = useState("");
  const [user, setUser] = useState(null); // {participantId,userName,recoveryCode,createdAt}

  // participant navigation
  const [participantScreen, setParticipantScreen] = useState("entry"); // entry | register | quiz

  // modals
  const [adminLoginOpen, setAdminLoginOpen] = useState(false);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const [recoveryModalCode, setRecoveryModalCode] = useState("");
  const [exitConfirm1Open, setExitConfirm1Open] = useState(false);
  const [exitConfirm2Open, setExitConfirm2Open] = useState(false);

  // name taken modal
  const [nameTakenModal, setNameTakenModal] = useState({
    open: false,
    inputName: "",
    existingPid: "",
    canOneClick: false,
    existingName: "",
  });

  // ===== Subscribe DB root =====
  useEffect(() => {
    const rootRef = ref(db, "/");
    const unsub = onValue(rootRef, (snap) => {
      const val = snap.val();
      if (!val) {
        set(rootRef, initialData);
        setData(initialData);
        setIsConnected(true);
        return;
      }
      setData({
        quizStatus: val.quizStatus ?? "running",
        stoppedAt: val.stoppedAt ?? null,
        currentQuestionIndex: val.currentQuestionIndex ?? 0,

        users: val.users ?? {},
        userNameIndex: val.userNameIndex ?? {},
        recoveryCodeIndex: val.recoveryCodeIndex ?? {},

        startTimes: val.startTimes ?? {},
        submissions: val.submissions ?? {},
      });
      setIsConnected(true);
    });
    return () => unsub();
  }, []);

  // ===== Restore identity (but DO NOT auto enter quiz) =====
  useEffect(() => {
    const saved = localStorage.getItem(LS_PARTICIPANT_ID);
    if (!saved) {
      setParticipantId("");
      setUser(null);
      return;
    }
    const u = (data.users || {})[saved];
    if (u) {
      setParticipantId(saved);
      setUser({ participantId: saved, ...u });
    } else {
      localStorage.removeItem(LS_PARTICIPANT_ID);
      setParticipantId("");
      setUser(null);
    }
  }, [data.users]);

  // ===== Derived =====
  const isStopped = data.quizStatus === "stopped";
  const isNaturalEnded = data.quizStatus === "running" && data.currentQuestionIndex >= totalQuestions;
  const isInProgress = data.quizStatus === "running" && data.currentQuestionIndex < totalQuestions;

  const currentQuestion =
    data.currentQuestionIndex >= 0 && data.currentQuestionIndex < totalQuestions
      ? allQuestions[data.currentQuestionIndex]
      : null;

  const leaderboardLive = useMemo(() => {
    return computeLeaderboard(
      { users: data.users, submissions: data.submissions },
      totalQuestions,
      { includePenalty: false }
    );
  }, [data.users, data.submissions, totalQuestions]);

  const leaderboardFinal = useMemo(() => {
    return computeLeaderboard(
      { users: data.users, submissions: data.submissions },
      totalQuestions,
      { includePenalty: true }
    );
  }, [data.users, data.submissions, totalQuestions]);

  const myRowFinal = useMemo(() => {
    if (!participantId) return null;
    return leaderboardFinal.find((r) => r.participantId === participantId) || null;
  }, [leaderboardFinal, participantId]);

  // ===== Participant view =====
  const participantView = useMemo(() => {
    if (mode !== "participant") return null;

    if (isStopped) return { type: "closed" };
    if (isNaturalEnded) return { type: "thanks" };

    if (!user || !participantId) {
      return { type: participantScreen === "register" ? "register" : "entry" };
    }

    return { type: participantScreen === "quiz" ? "quiz" : "entry" };
  }, [mode, isStopped, isNaturalEnded, user, participantId, participantScreen]);

  // ===== Ensure start time helper =====
  async function ensureStartTimeForCurrentQuestion(pid) {
    if (!pid) return;
    if (data.quizStatus !== "running") return;
    if (!currentQuestion) return;

    const qid = currentQuestion.id;
    const subKey = `${pid}_${qid}`;
    if ((data.submissions || {})[subKey]) return;

    const stKey = `${pid}_${qid}`;
    const stRef = ref(db, `/startTimes/${stKey}`);
    await runTransaction(stRef, (cur) => (cur === null ? now() : cur)).catch(() => {});
  }

  // ===== Start time is written ONLY while on quiz screen =====
  useEffect(() => {
    if (mode !== "participant") return;
    if (!user || !participantId) return;
    if (!isInProgress) return;
    if (participantScreen !== "quiz") return; // IMPORTANT
    if (!currentQuestion) return;

    const subKey = `${participantId}_${currentQuestion.id}`;
    if ((data.submissions || {})[subKey]) return;

    const stKey = `${participantId}_${currentQuestion.id}`;
    const stRef = ref(db, `/startTimes/${stKey}`);
    runTransaction(stRef, (cur) => (cur === null ? now() : cur)).catch(() => {});
  }, [mode, user, participantId, isInProgress, participantScreen, currentQuestion, data.submissions]);

  // ===== Identity helpers =====
  async function reserveRecoveryCodeUnique() {
    for (let i = 0; i < 12; i++) {
      const code = generateRecoveryCode();
      const idxRef = ref(db, `/recoveryCodeIndex/${code}`);
      const tx = await runTransaction(idxRef, (cur) => {
        if (cur === null) return "__RESERVED__";
        return;
      });
      if (tx.committed && tx.snapshot.val() === "__RESERVED__") return code;
    }
    throw new Error("Failed to reserve recovery code. Please retry.");
  }

  async function registerNewUser(userNameRaw) {
    const name = normalizeName(userNameRaw);
    const lower = normalizeNameKey(name);
    if (!name) return { ok: false, error: "请输入昵称 / Please enter a nickname." };

    const userNameIdxRef = ref(db, `/userNameIndex/${lower}`);
    const desiredId = generateId();

    const userNameTx = await runTransaction(userNameIdxRef, (cur) => {
      if (cur === null) return desiredId;
      return;
    });

    if (!userNameTx.committed) {
      const existingPid = userNameTx.snapshot.val() || "";
      return {
        ok: false,
        code: "NAME_TAKEN",
        existingParticipantId: existingPid,
        error:
          "该昵称已存在。系统将检测本机是否为该用户，可一键进入；否则请用恢复码找回。",
      };
    }

    let code;
    try {
      code = await reserveRecoveryCodeUnique();
    } catch {
      await runTransaction(userNameIdxRef, (cur) => {
        if (cur === desiredId) return null;
        return cur;
      });
      return { ok: false, error: "系统繁忙，请重试 / Please retry." };
    }

    const createdAt = now();
    const userObj = { userName: name, recoveryCode: code, createdAt };

    await update(ref(db, "/"), {
      [`users/${desiredId}`]: userObj,
      [`recoveryCodeIndex/${code}`]: desiredId,
    });

    localStorage.setItem(LS_PARTICIPANT_ID, desiredId);
    setParticipantId(desiredId);
    setUser({ participantId: desiredId, ...userObj });

    // show modal, do not start timing yet
    setRecoveryModalCode(code);
    setRecoveryModalOpen(true);
    setParticipantScreen("entry");

    return { ok: true };
  }

  async function recoverByCode(codeRaw) {
    const code = normalizeRecoveryCode(codeRaw);
    if (!code) return { ok: false, error: "请输入恢复码 / Please enter recovery code." };

    const pid = (data.recoveryCodeIndex || {})[code];
    if (!pid) return { ok: false, error: "恢复码无效 / Invalid recovery code." };

    const u = (data.users || {})[pid];
    if (!u) return { ok: false, error: "用户不存在或已被重置 / User not found." };

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setUser({ participantId: pid, ...u });

    // do not auto enter quiz
    setParticipantScreen("entry");
    return { ok: true };
  }

  async function enterQuiz() {
    setParticipantScreen("quiz");
    await ensureStartTimeForCurrentQuestion(participantId);
  }

  // ===== Name taken flow =====
  function openNameTakenModal(inputName, existingPid) {
    const storedPid = localStorage.getItem(LS_PARTICIPANT_ID);
    const existingUser = (data.users || {})[existingPid];
    const storedUser = storedPid ? (data.users || {})[storedPid] : null;

    const canOneClick =
      !!storedPid &&
      storedPid === existingPid &&
      !!storedUser &&
      normalizeNameKey(storedUser.userName) === normalizeNameKey(inputName);

    setNameTakenModal({
      open: true,
      inputName,
      existingPid,
      canOneClick,
      existingName: existingUser?.userName || inputName,
    });
  }

  async function oneClickEnterExistingUser(existingPid) {
    const storedPid = localStorage.getItem(LS_PARTICIPANT_ID);
    if (storedPid !== existingPid) return;

    const u = (data.users || {})[existingPid];
    if (!u) return;

    setParticipantId(existingPid);
    setUser({ participantId: existingPid, ...u });
    setNameTakenModal((s) => ({ ...s, open: false }));

    await enterQuiz();
  }

  // ===== Exit flow =====
  function openExitFlow() {
    setExitConfirm1Open(true);
  }
  function confirmExitStep1() {
    setExitConfirm1Open(false);
    setExitConfirm2Open(true);
  }
  function confirmExitFinal() {
    setExitConfirm2Open(false);
    localStorage.removeItem(LS_PARTICIPANT_ID);
    setParticipantId("");
    setUser(null);
    setParticipantScreen("entry");
    setMode("participant");
  }

  // ===== Submit =====
  async function submitAnswer(answerId) {
    if (!user || !participantId) return { ok: false, error: "未登录 / Not logged in." };
    if (data.quizStatus !== "running") return { ok: false, error: "问卷已关闭 / Closed." };
    if (!currentQuestion) return { ok: false, error: "当前无题目 / No question." };

    const q = currentQuestion;
    const key = `${participantId}_${q.id}`;
    const stKey = `${participantId}_${q.id}`;
    const startTime = (data.startTimes || {})[stKey] || now();
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

    const subRef = ref(db, `/submissions/${key}`);
    const tx = await runTransaction(subRef, (cur) => {
      if (cur === null) return submission;
      return;
    });

    if (!tx.committed) return { ok: false, error: "已提交过 / Already submitted." };
    return { ok: true };
  }

  // ===== Admin controls =====
  async function adminNextQuestion() {
    if (data.quizStatus !== "running") return;
    const next = Math.min(data.currentQuestionIndex + 1, totalQuestions);
    await update(ref(db, "/"), { currentQuestionIndex: next });
  }
  async function adminStop() {
    await update(ref(db, "/"), { quizStatus: "stopped", stoppedAt: now() });
  }
  async function adminReset() {
    if (!window.confirm("确认重置所有数据？This will clear all data.")) return;
    await set(ref(db, "/"), initialData);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <TopBar
        isConnected={isConnected}
        mode={mode}
        onGoParticipant={() => setMode("participant")}
        onOpenAdmin={() => setAdminLoginOpen(true)}
        user={user}
      />

      {adminLoginOpen && (
        <AdminLoginModal
          onClose={() => setAdminLoginOpen(false)}
          onSuccess={() => {
            setAdminLoginOpen(false);
            setMode("admin");
          }}
        />
      )}

      {recoveryModalOpen && (
        <RecoveryCodeModal
          code={recoveryModalCode}
          onConfirm={async () => {
            setRecoveryModalOpen(false);
            await enterQuiz();
          }}
        />
      )}

      {nameTakenModal.open && (
        <NameTakenModal
          canOneClick={nameTakenModal.canOneClick}
          existingName={nameTakenModal.existingName}
          onClose={() => setNameTakenModal((s) => ({ ...s, open: false }))}
          onOneClickEnter={() => oneClickEnterExistingUser(nameTakenModal.existingPid)}
          onUseRecovery={() => setNameTakenModal((s) => ({ ...s, open: false }))}
        />
      )}

      {exitConfirm1Open && (
        <ConfirmModal
          title="确认退出？"
          description="退出将清除本设备身份。重新进入需要恢复码找回。"
          confirmText="继续退出"
          cancelText="取消"
          onCancel={() => setExitConfirm1Open(false)}
          onConfirm={confirmExitStep1}
        />
      )}

      {exitConfirm2Open && (
        <ExitFinalModal
          code={user?.recoveryCode || ""}
          onCancel={() => setExitConfirm2Open(false)}
          onConfirm={confirmExitFinal}
        />
      )}

      {mode === "admin" ? (
        <AdminDashboard
          data={data}
          questions={allQuestions}
          leaderboardLive={leaderboardLive}
          leaderboardFinal={leaderboardFinal}
          isInProgress={isInProgress}
          onBack={() => setMode("participant")}
          onNext={adminNextQuestion}
          onStop={adminStop}
          onReset={adminReset}
        />
      ) : (
        <ParticipantShell
          view={participantView}
          data={data}
          user={user}
          participantId={participantId}
          currentQuestion={currentQuestion}
          questions={allQuestions}
          leaderboardFinal={leaderboardFinal}
          myRowFinal={myRowFinal}
          onStart={() => setParticipantScreen("register")}
          onBackHome={() => setParticipantScreen("entry")}
          onEnterQuiz={enterQuiz}
          onRegister={registerNewUser}
          onRecover={recoverByCode}
          onNameTaken={openNameTakenModal}
          onSubmit={submitAnswer}
          onExit={openExitFlow}
        />
      )}
    </div>
  );
}

// ===== Top Bar =====
function TopBar({ isConnected, mode, onGoParticipant, onOpenAdmin, user }) {
  return (
    <div className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold">Realtime Quiz</div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
              }`}
            />
            {isConnected ? "Online" : "Connecting"}
          </div>
          {mode === "admin" && (
            <span className="ml-2 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300">
              Admin
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {mode === "admin" ? (
            <button
              onClick={onGoParticipant}
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

// ===== Participant Shell =====
function ParticipantShell({
  view,
  data,
  user,
  participantId,
  currentQuestion,
  questions,
  leaderboardFinal,
  myRowFinal,
  onStart,
  onBackHome,
  onEnterQuiz,
  onRegister,
  onRecover,
  onNameTaken,
  onSubmit,
  onExit,
}) {
  if (!view) return null;

  if (view.type === "entry") {
    return (
      <EntryPage
        quizStatus={data.quizStatus}
        currentQuestionIndex={data.currentQuestionIndex}
        totalQuestions={questions.length}
        user={user}
        onStart={onStart}
        onEnterQuiz={onEnterQuiz}
        onExit={onExit}
      />
    );
  }

  if (view.type === "register") {
    return (
      <RegisterRecoverPage
        onBack={onBackHome}
        onRegister={onRegister}
        onRecover={onRecover}
        onNameTaken={onNameTaken}
      />
    );
  }

  if (view.type === "closed") {
    return (
      <ClosedPage
        leaderboard={leaderboardFinal}
        myRow={myRowFinal}
        totalQuestions={questions.length}
        onBackHome={onBackHome}
      />
    );
  }

  if (view.type === "thanks") {
    return (
      <ThanksPage
        leaderboard={leaderboardFinal}
        myRow={myRowFinal}
        totalQuestions={questions.length}
        onBackHome={onBackHome}
        onExit={onExit}
      />
    );
  }

  if (view.type === "quiz") {
    return (
      <QuizPage
        data={data}
        user={user}
        participantId={participantId}
        currentQuestion={currentQuestion}
        totalQuestions={questions.length}
        onSubmit={onSubmit}
        onExit={onExit}
      />
    );
  }

  return null;
}

// ===== Entry Page =====
function EntryPage({ quizStatus, currentQuestionIndex, totalQuestions, user, onStart, onEnterQuiz, onExit }) {
  const statusText =
    quizStatus === "stopped"
      ? "问卷已关闭 / Closed"
      : currentQuestionIndex >= totalQuestions
      ? "已完成 / Finished"
      : "进行中 / Running";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">参与答题</h1>
            <p className="mt-1 text-sm text-slate-400">状态：{statusText}</p>
          </div>
          {user ? (
            <button
              onClick={onExit}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              退出
            </button>
          ) : null}
        </div>

        <div className="mt-6 space-y-3 text-sm text-slate-300">
          <div>规则：昵称唯一；每人一个恢复码（用于换设备找回）。</div>
          <div>开始计时：仅在点击“直接进入/我已保存，进入”后开始。</div>
        </div>

        {user ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm text-slate-200">
              欢迎回来！检测到本浏览器用户：<span className="font-semibold">{user.userName}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={onEnterQuiz}
                className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 font-semibold hover:bg-indigo-500"
              >
                直接进入
              </button>
              <button
                onClick={onStart}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-200 hover:bg-slate-800"
              >
                切换/注册
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <button
              onClick={onStart}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-500"
            >
              开始 / Start
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Register / Recover Page =====
function RegisterRecoverPage({ onBack, onRegister, onRecover, onNameTaken }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleRegister() {
    setError("");
    setBusy(true);
    const res = await onRegister(name);
    setBusy(false);

    if (!res.ok) {
      if (res.code === "NAME_TAKEN") {
        onNameTaken(normalizeName(name), res.existingParticipantId);
        return;
      }
      setError(res.error || "注册失败 / Failed.");
    }
  }

  async function handleRecover() {
    setError("");
    setBusy(true);
    const res = await onRecover(code);
    setBusy(false);
    if (!res.ok) setError(res.error || "找回失败 / Failed.");
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <button onClick={onBack} className="text-sm text-slate-400 hover:text-slate-200">
          ← 回到主页面
        </button>

        <h2 className="mt-4 text-xl font-bold">注册 / 找回</h2>
        <p className="mt-2 text-sm text-slate-400">新用户输入昵称注册；老用户输入恢复码找回身份。</p>

        <div className="mt-6 grid gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">新用户注册</div>
            <label className="mt-3 block text-xs text-slate-400">昵称（唯一）</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-indigo-500"
              placeholder="例如：SHI"
              autoComplete="off"
            />
            <button
              disabled={busy || !normalizeName(name)}
              onClick={handleRegister}
              className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 font-semibold disabled:opacity-50"
            >
              注册并进入
            </button>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="text-sm font-semibold">老用户找回</div>
            <label className="mt-3 block text-xs text-slate-400">恢复码</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-slate-100 outline-none focus:border-indigo-500"
              placeholder="例如：A2BC9D"
              autoComplete="off"
            />
            <button
              disabled={busy || !normalizeRecoveryCode(code)}
              onClick={handleRecover}
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-50"
            >
              使用恢复码进入
            </button>
          </div>

          {error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ===== Quiz Page =====
function QuizPage({ data, user, participantId, currentQuestion, totalQuestions, onSubmit, onExit }) {
  const [selected, setSelected] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  const questionId = currentQuestion?.id;
  const subKey = participantId && questionId ? `${participantId}_${questionId}` : "";
  const submission = subKey ? (data.submissions || {})[subKey] : null;
  const hasSubmitted = !!submission;

  const stKey = participantId && questionId ? `${participantId}_${questionId}` : "";
  const startTime = stKey ? (data.startTimes || {})[stKey] : null;

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    setSelected(null);
    setErr("");
  }, [data.currentQuestionIndex]);

  useEffect(() => {
    if (!startTime || hasSubmitted) return;
    const t = setInterval(() => setElapsed(Math.max(0, now() - startTime)), 100);
    return () => clearInterval(t);
  }, [startTime, hasSubmitted]);

  async function handleSubmit() {
    if (!selected) return;
    setErr("");
    setSubmitting(true);
    const res = await onSubmit(selected);
    setSubmitting(false);
    if (!res.ok) setErr(res.error || "提交失败 / Failed.");
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
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
            <h2 className="mt-2 whitespace-pre-line text-xl font-bold">
              {currentQuestion?.question || "无题目"}
            </h2>
          </div>

          {!hasSubmitted ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-right">
              <div className="text-xs text-slate-400">用时</div>
              <div className="font-mono text-lg font-semibold text-amber-300">
                {formatMs(startTime ? elapsed : 0)}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-800 bg-slate-950 px-4 py-2 text-right">
              <div className="text-xs text-slate-400">已提交</div>
              <div className="font-mono text-lg font-semibold text-slate-200">
                {formatMs(submission.duration)}
              </div>
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
              <button
                key={opt.id}
                disabled={hasSubmitted}
                onClick={() => setSelected(opt.id)}
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
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-3 text-sm text-slate-300">
              已提交，等待下一题。
            </div>
          ) : (
            <button
              disabled={!selected || submitting}
              onClick={handleSubmit}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-base font-semibold disabled:opacity-50"
            >
              {submitting ? "提交中..." : "提交"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== Thanks / Closed =====
function ThanksPage({ leaderboard, myRow, totalQuestions, onBackHome, onExit }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-4 flex items-center justify-between">
        <button onClick={onBackHome} className="text-sm text-slate-400 hover:text-slate-200">
          ← 回到主页面
        </button>
        <button
          onClick={onExit}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          退出
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <h2 className="text-2xl font-bold">谢谢参与</h2>
        <p className="mt-2 text-sm text-slate-400">最终榜单：正确率↓，总耗时↑（未作答每题 +120s）。</p>
        <div className="mt-6">
          <MyStats myRow={myRow} totalQuestions={totalQuestions} />
        </div>
      </div>

      <div className="mt-6">
        <LeaderboardTable leaderboard={leaderboard} totalQuestions={totalQuestions} variant="final" />
      </div>
    </div>
  );
}

function ClosedPage({ leaderboard, myRow, totalQuestions, onBackHome }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-4">
        <button onClick={onBackHome} className="text-sm text-slate-400 hover:text-slate-200">
          ← 回到主页面
        </button>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
        <h2 className="text-2xl font-bold">问卷已关闭</h2>
        <p className="mt-2 text-sm text-slate-400">最终榜单：正确率↓，总耗时↑（未作答每题 +120s）。</p>
        <div className="mt-6">
          <MyStats myRow={myRow} totalQuestions={totalQuestions} />
        </div>
      </div>

      <div className="mt-6">
        <LeaderboardTable leaderboard={leaderboard} totalQuestions={totalQuestions} variant="final" />
      </div>
    </div>
  );
}

function MyStats({ myRow, totalQuestions }) {
  if (!myRow) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm text-slate-300">
        未识别到用户身份。
      </div>
    );
  }
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

function LeaderboardTable({ leaderboard, totalQuestions, variant }) {
  const isLive = variant === "live";
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-lg font-bold">排行榜 Leaderboard</h3>
        <div className="text-xs text-slate-400 text-right">
          {isLive
            ? "进行中：仅统计已作答题目的累计耗时；结束后未作答每题 +120s"
            : "排序：正确率↓，总耗时↑（未作答每题 +120s）"}
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
              <th className="py-2 pr-3">{isLive ? "Answered Time" : "Total Time"}</th>
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
                  <td className="py-2 pr-3 font-mono">
                    {isLive ? formatMs(r.answeredTime) : formatMs(r.totalTime)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===== Admin Dashboard =====
function AdminDashboard({
  data,
  questions,
  leaderboardLive,
  leaderboardFinal,
  isInProgress,
  onBack,
  onNext,
  onStop,
  onReset,
}) {
  const totalQuestions = questions.length;
  const idx = data.currentQuestionIndex;
  const currentQ = idx >= 0 && idx < totalQuestions ? questions[idx] : null;

  const currentSubs = useMemo(() => {
    if (!currentQ) return [];
    const subsObj = data.submissions || {};
    const list = Object.values(subsObj).filter((s) => s.questionId === currentQ.id);
    list.sort((a, b) => (a.submitTime || 0) - (b.submitTime || 0));
    return list;
  }, [data.submissions, currentQ]);

  const isNaturalEnded = data.quizStatus === "running" && data.currentQuestionIndex >= totalQuestions;

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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-slate-400">当前题目 Current</div>
              <div className="mt-1 text-lg font-bold">
                {currentQ ? `Q${currentQ.id}` : "已无题目（自然结束）"}
              </div>
              {currentQ ? (
                <div className="mt-2 whitespace-pre-line text-sm text-slate-200">{currentQ.question}</div>
              ) : (
                <div className="mt-2 text-sm text-slate-400">
                  当前索引已越界，参与者端将显示“谢谢参与”页。
                </div>
              )}
              {currentQ ? (
                <div className="mt-3 text-sm text-emerald-300">
                  正确答案 Answer: <span className="font-mono">{currentQ.correctAnswer}</span>
                </div>
              ) : null}
            </div>

            <div className="flex gap-2">
              <button
                disabled={data.quizStatus !== "running" || data.currentQuestionIndex >= totalQuestions}
                onClick={onNext}
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
              >
                下一题 Next
              </button>
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
              <div className="text-sm font-semibold">本题实时提交</div>
              <div className="text-xs text-slate-400">不展示提交时间点，仅看耗时/对错</div>
            </div>

            {currentQ ? (
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
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="text-sm font-semibold">完整题库（含答案）</div>
          <div className="mt-2 text-xs text-slate-400">当前题高亮</div>
          <div className="mt-4 max-h-[560px] overflow-auto pr-1">
            <div className="space-y-3">
              {questions.map((q, index) => (
                <div
                  key={q.id}
                  className={`rounded-xl border p-3 ${
                    index === data.currentQuestionIndex
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
                  <div className="mt-2 grid gap-1">
                    {q.options.map((o) => (
                      <div key={o.id} className="text-xs text-slate-300">
                        <span className="mr-2 font-mono text-slate-400">{o.id}.</span>
                        {o.text}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
                自然结束条件：currentQuestionIndex ≥ {totalQuestions}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <LeaderboardTable
          leaderboard={isInProgress ? leaderboardLive : leaderboardFinal}
          totalQuestions={totalQuestions}
          variant={isInProgress ? "live" : "final"}
        />
      </div>
    </div>
  );
}

// ===== Admin Login Modal =====
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
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {err}
          </div>
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

// ===== Recovery Code Modal =====
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
          换设备或清理缓存后，用它找回身份。每人一个，固定不变。
          <br />
          计时将在你点击“我已保存，进入”后开始。
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
            我已保存，进入
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ===== Name Taken Modal =====
function NameTakenModal({ canOneClick, existingName, onClose, onOneClickEnter, onUseRecovery }) {
  return (
    <ModalShell onClose={onClose}>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="text-lg font-bold">昵称已存在</div>
        <div className="mt-2 text-sm text-slate-400">
          系统检测到昵称 <span className="font-semibold text-slate-200">{existingName}</span> 已注册。
          <br />
          是否检测到本机就是该用户？
        </div>

        {canOneClick ? (
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
            已检测到本机身份匹配该用户，可一键进入（无需恢复码）。
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            未检测到本机有该用户身份。请使用恢复码找回。
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onUseRecovery}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            使用恢复码
          </button>

          <button
            disabled={!canOneClick}
            onClick={onOneClickEnter}
            className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            一键进入
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ===== Confirm Modals =====
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

function ExitFinalModal({ code, onCancel, onConfirm }) {
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
        <div className="mt-2 text-sm text-slate-400">
          退出会清除本设备身份。请先截图/复制恢复码，否则可能无法找回。
        </div>

        <div className="mt-4 rounded-xl border border-indigo-500/30 bg-slate-950 p-4 text-center">
          <div className="select-all font-mono text-3xl font-bold tracking-widest text-indigo-200">
            {code || "-"}
          </div>
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

// ===== Modal Shell =====
function ModalShell({ children, onClose }) {
  const closable = typeof onClose === "function";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={closable ? onClose : undefined}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ===== Mount =====
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
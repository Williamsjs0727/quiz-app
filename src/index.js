
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { db } from "./firebase";
import { ref, onValue, set, update } from "firebase/database";

// ========== 管理员密码 ==========
const ADMIN_PASSWORD = "ennebei";

// ========== localStorage Keys ==========
const LS_PARTICIPANT_ID = "quiz_participant_id";

// ========== 题目数据（含正确答案） ==========
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
    question: "CSS 中，哪个属性用于设置弹性布局？\nIn CSS, which property is used to set flex layout?",
    options: [
      { id: "A", text: "display: block" },
      { id: "B", text: "display: flex" },
      { id: "C", text: "display: grid" },
      { id: "D", text: "display: inline" },
    ],
    correctAnswer: "B",
  },
];

// ========== 工具函数 ==========
function generateId() {
  // 足够用于活动答题（非安全用途）
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

function generateRecoveryCode() {
  // 8位：易抄写；不含易混字符（0/O, 1/I）
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${s}.${d}s`;
}

const initialData = {
  quizStatus: "running", // "running" | "stopped"
  stoppedAt: null,

  currentQuestionIndex: 0,
  registeredUsers: [], // [{ participantId, userName, recoveryCode, createdAt }]
  submissions: [], // [{ participantId, userName, questionId, answer, isCorrect, duration, ... }]
  questionStartTimes: {}, // { `${participantId}_${questionId}`: timestamp }
};

// ========== 主应用 ==========
function App() {
  const [page, setPage] = useState("entry");
  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);

  // 当前用户（以 participantId 追踪）
  const [participantId, setParticipantId] = useState("");
  const [currentUserName, setCurrentUserName] = useState("");

  // 管理员入口弹窗
  const [showAdminPasswordModal, setShowAdminPasswordModal] = useState(false);

  // 首次注册后展示恢复码
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [newRecoveryCode, setNewRecoveryCode] = useState("");

  // 监听 DB
  useEffect(() => {
    const dataRef = ref(db, "/");
    const unsubscribe = onValue(dataRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        setData({
          quizStatus: val.quizStatus || "running",
          stoppedAt: val.stoppedAt || null,
          currentQuestionIndex: val.currentQuestionIndex || 0,
          registeredUsers: val.registeredUsers || [],
          submissions: val.submissions || [],
          questionStartTimes: val.questionStartTimes || {},
        });
      } else {
        set(dataRef, initialData);
      }
      setIsConnected(true);
    });
    return () => unsubscribe();
  }, []);

  // 自动识别（同一设备重新进入）
  useEffect(() => {
    const pid = localStorage.getItem(LS_PARTICIPANT_ID);
    if (!pid) return;

    const u = (data.registeredUsers || []).find((x) => x.participantId === pid);
    if (!u) return;

    setParticipantId(pid);
    setCurrentUserName(u.userName);

    // 如果用户在首页且点击参与，能直接进答题；避免强制跳页打断管理员操作
    // 你也可以改成自动跳转到 quiz：如果想要就把下面注释取消
    // if (page === "entry" || page === "register") setPage("quiz");
  }, [data.registeredUsers]); // 只依赖用户列表

  const currentQuestion = allQuestions[data.currentQuestionIndex];

  // ========== 用户注册/找回 ==========
  // 规则：
  // - 同设备：localStorage 自动识别，无需任何输入
  // - 新用户：输入昵称 => 生成 participantId + recoveryCode
  // - 换设备：输入恢复码 => 找回 participantId（可选更新昵称）
  const handleJoin = async ({ userName, recoveryCode }) => {
    const trimmedName = (userName || "").trim();

    if (!trimmedName) {
      return { ok: false, error: "请输入昵称 Please enter a nickname" };
    }
    if (trimmedName.length < 2) {
      return { ok: false, error: "昵称至少2个字符 Nickname must be at least 2 characters" };
    }

    const trimmedCode = (recoveryCode || "").trim().toUpperCase();

    // 走“恢复码找回”
    if (trimmedCode) {
      const found = (data.registeredUsers || []).find((u) => u.recoveryCode === trimmedCode);
      if (!found) {
        return { ok: false, error: "恢复码无效 Invalid recovery code" };
      }

      // 找回成功：把该 participantId 写入本机
      localStorage.setItem(LS_PARTICIPANT_ID, found.participantId);
      setParticipantId(found.participantId);

      // 可选：更新昵称（方便跨设备时换一个显示名）
      if (found.userName !== trimmedName) {
        const updatedUsers = (data.registeredUsers || []).map((u) =>
          u.participantId === found.participantId ? { ...u, userName: trimmedName } : u
        );
        await update(ref(db, "/"), { registeredUsers: updatedUsers });

        setCurrentUserName(trimmedName);

        // 同步更新 submissions 里的显示名（保持排行榜一致）
        const updatedSubs = (data.submissions || []).map((s) =>
          s.participantId === found.participantId ? { ...s, userName: trimmedName } : s
        );
        await update(ref(db, "/"), { submissions: updatedSubs });
      } else {
        setCurrentUserName(found.userName);
      }

      setPage("quiz");
      return { ok: true };
    }

    // 新用户：创建 participantId + recoveryCode
    const pid = generateId();
    let code = generateRecoveryCode();

    // 极小概率重复，做一次简单去重
    const usedCodes = new Set((data.registeredUsers || []).map((u) => u.recoveryCode));
    while (usedCodes.has(code)) code = generateRecoveryCode();

    const newUser = {
      participantId: pid,
      userName: trimmedName,
      recoveryCode: code,
      createdAt: Date.now(),
    };

    await update(ref(db, "/"), { registeredUsers: [...(data.registeredUsers || []), newUser] });

    localStorage.setItem(LS_PARTICIPANT_ID, pid);
    setParticipantId(pid);
    setCurrentUserName(trimmedName);

    setNewRecoveryCode(code);
    setShowRecoveryModal(true);

    setPage("quiz");
    return { ok: true };
  };

  // ========== 计时：进入每题开始 ==========
  useEffect(() => {
    if (page !== "quiz") return;
    if (!participantId) return;
    if (!currentQuestion) return;

    const key = `${participantId}_${currentQuestion.id}`;
    const existing = data.questionStartTimes[key];

    // 如果已经提交过本题，不再写开始时间
    const alreadySubmitted = (data.submissions || []).some(
      (s) => s.participantId === participantId && s.questionId === currentQuestion.id
    );
    if (alreadySubmitted) return;

    if (!existing) {
      const now = Date.now();
      update(ref(db, "/questionStartTimes"), { [key]: now });
    }
  }, [page, participantId, data.currentQuestionIndex, currentQuestion, data.questionStartTimes, data.submissions]); }, [page, participantId, data.currentQuestionIndex, currentQuestion?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ========== 提交答案 ==========
  const handleSubmit = async (answer) => {
    if (!participantId || !currentQuestion) return;

    if (data.quizStatus === "stopped") {
      alert("问卷已结束，无法提交。\nQuiz has ended. Submission is disabled.");
      return;
    }

    const alreadySubmitted = (data.submissions || []).some(
      (s) => s.participantId === participantId && s.questionId === currentQuestion.id
    );
    if (alreadySubmitted) return;

    const key = `${participantId}_${currentQuestion.id}`;
    const startTime = data.questionStartTimes[key] || Date.now();
    const submitTime = Date.now();
    const duration = submitTime - startTime;

    const isCorrect = answer === currentQuestion.correctAnswer;

    const newSubmission = {
      id: generateId(),
      participantId,
      userName: currentUserName || "Anonymous",
      questionId: currentQuestion.id,
      answer,
      isCorrect,
      startTime,
      submitTime,
      duration,
      time: new Date().toLocaleTimeString("zh-CN"),
    };

    await update(ref(db, "/"), { submissions: [...(data.submissions || []), newSubmission] });
  };

  // ========== 管理员控制 ==========
  const handleNextQuestion = async () => {
    if (data.quizStatus === "stopped") return;
    if (data.currentQuestionIndex < allQuestions.length - 1) {
      await update(ref(db, "/"), { currentQuestionIndex: data.currentQuestionIndex + 1 });
    }
  };

  const handleStopQuiz = async () => {
    if (data.quizStatus === "stopped") return;
    if (
      window.confirm(
        "确定要停止问卷并进行最终结算吗？停止后参与者将无法继续答题。\nStop the quiz and settle final results? After stopping, participants cannot continue."
      )
    ) {
      await update(ref(db, "/"), { quizStatus: "stopped", stoppedAt: Date.now() });
    }
  };

  const handleResetAndStart = async () => {
    if (
      window.confirm(
        "确定要重置并重新开启问卷吗？将清空所有用户/提交/计时数据。\nReset and start a new quiz? This will clear all users/submissions/timers."
      )
    ) {
      await set(ref(db, "/"), { ...initialData, quizStatus: "running", stoppedAt: null });
      setPage("entry");
      setParticipantId("");
      setCurrentUserName("");
      localStorage.removeItem(LS_PARTICIPANT_ID);
      setShowRecoveryModal(false);
      setNewRecoveryCode("");
    }
  };

  // ========== 管理员密码 ==========
  const handleAdminClick = () => setShowAdminPasswordModal(true);

  const handleAdminPasswordSubmit = (password) => {
    if (password === ADMIN_PASSWORD) {
      setShowAdminPasswordModal(false);
      setPage("admin");
    } else {
      alert("密码错误！\nIncorrect password!");
    }
  };

  // ========== 结算/排行榜计算（用于参与者结束页 & 管理员） ==========
  const finalRanking = useMemo(() => {
    const stats = {};

    for (const u of data.registeredUsers || []) {
      stats[u.participantId] = {
        participantId: u.participantId,
        userName: u.userName,
        correctCount: 0,
        totalCorrectTime: 0, // 只累计答对题目的用时
        answeredCount: 0,
      };
    }

    for (const s of data.submissions || []) {
      if (!stats[s.participantId]) {
        stats[s.participantId] = {
          participantId: s.participantId,
          userName: s.userName || "Anonymous",
          correctCount: 0,
          totalCorrectTime: 0,
          answeredCount: 0,
        };
      }
      stats[s.participantId].answeredCount += 1;
      if (s.isCorrect) {
        stats[s.participantId].correctCount += 1;
        stats[s.participantId].totalCorrectTime += s.duration || 0;
      }
      // 尽量保持昵称最新
      if (s.userName) stats[s.participantId].userName = s.userName;
    }

    return Object.values(stats).sort((a, b) => {
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
      return a.totalCorrectTime - b.totalCorrectTime;
    });
  }, [data.registeredUsers, data.submissions]);

  const myStats = useMemo(() => {
    if (!participantId) return null;
    const me = finalRanking.find((x) => x.participantId === participantId);
    return me || {
      participantId,
      userName: currentUserName || "Anonymous",
      correctCount: 0,
      totalCorrectTime: 0,
      answeredCount: 0,
    };
  }, [participantId, currentUserName, finalRanking]);

  // ===== 入口页面 =====
  if (page === "entry") {
    const autoUser =
      participantId && (data.registeredUsers || []).find((u) => u.participantId === participantId);

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        {showAdminPasswordModal && (
          <PasswordModal
            titleZh="管理员验证"
            titleEn="Admin Verification"
            tipZh="请输入管理员密码"
            tipEn="Please enter admin password"
            onSubmit={handleAdminPasswordSubmit}
            onClose={() => setShowAdminPasswordModal(false)}
          />
        )}

        {showRecoveryModal && (
          <RecoveryModal
            recoveryCode={newRecoveryCode}
            onClose={() => setShowRecoveryModal(false)}
          />
        )}

        <div className="max-w-2xl w-full">
          <div className="flex justify-center mb-6">
            <div
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm ${
                isConnected
                  ? "bg-green-500/20 text-green-400 border border-green-500/30"
                  : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isConnected ? "bg-green-400" : "bg-yellow-400 animate-pulse"
                }`}
              />
              {isConnected ? "已连接云端数据库 Connected to Cloud" : "连接中 Connecting..."}
            </div>
          </div>

          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl mb-6 shadow-lg">
              <span className="text-4xl">✨</span>
            </div>
            <h1 className="text-4xl font-bold text-white mb-3">实时答题系统</h1>
            <p className="text-2xl text-slate-300 mb-2">Real-time Quiz System</p>

            <div className="mt-4">
              {data.quizStatus === "stopped" ? (
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-500/15 border border-red-500/30 text-red-300 text-sm">
                  <span className="font-bold">已停止</span>
                  <span className="text-red-300/80">Stopped</span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-sm">
                  <span className="font-bold">进行中</span>
                  <span className="text-indigo-300/80">Running</span>
                </div>
              )}
            </div>

            {autoUser && (
              <div className="mt-5 text-slate-300">
                <p>
                  已识别到你的设备：<span className="font-semibold text-white">{autoUser.userName}</span>
                </p>
                <p className="text-slate-500 text-sm">We recognized your device.</p>
              </div>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <button
              onClick={() => setPage("register")}
              className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-indigo-500 rounded-2xl p-8 text-left transition-all"
            >
              <div className="w-14 h-14 bg-indigo-500/20 group-hover:bg-indigo-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">👤</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-1">参与答题</h2>
              <p className="text-slate-300 mb-2">Join Quiz</p>
              <p className="text-slate-400 mb-1">同设备自动识别 · 换设备用恢复码</p>
              <p className="text-slate-500 text-sm mb-4">
                Auto on same device · Use recovery code on new device
              </p>
              <div className="flex items-center text-indigo-400 font-medium">进入 Enter →</div>
            </button>

            <button
              onClick={handleAdminClick}
              className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-purple-500 rounded-2xl p-8 text-left transition-all"
            >
              <div className="w-14 h-14 bg-purple-500/20 group-hover:bg-purple-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">📊</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-1">管理看板</h2>
              <p className="text-slate-300 mb-2">Admin Dashboard</p>
              <p className="text-slate-400 mb-1">控制节奏 · 停止并最终结算</p>
              <p className="text-slate-500 text-sm mb-4">Control pace · Stop & settle</p>
              <div className="flex items-center text-purple-400 font-medium">进入 Enter →</div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 参与者入口 =====
  if (page === "register") {
    return (
      <JoinPage
        data={data}
        participantId={participantId}
        onJoin={handleJoin}
        onBack={() => setPage("entry")}
      />
    );
  }

  // ===== 答题页面 =====
  if (page === "quiz") {
    return (
      <QuizPage
        data={data}
        participantId={participantId}
        userName={currentUserName}
        currentQuestion={currentQuestion}
        onSubmit={handleSubmit}
        onBack={() => setPage("entry")}
        finalRanking={finalRanking}
        myStats={myStats}
      />
    );
  }

  // ===== 管理页面 =====
  if (page === "admin") {
    return (
      <AdminPage
        data={data}
        finalRanking={finalRanking}
        onNextQuestion={handleNextQuestion}
        onStopQuiz={handleStopQuiz}
        onResetAndStart={handleResetAndStart}
        onBack={() => setPage("entry")}
      />
    );
  }

  return null;
}

// ========== 通用密码弹窗 ==========
function PasswordModal({ titleZh, titleEn, tipZh, tipEn, onSubmit, onClose }) {
  const [password, setPassword] = useState("");
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🔐</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">{titleZh}</h2>
          <p className="text-slate-300">{titleEn}</p>
          <p className="text-slate-400 mt-2">{tipZh}</p>
          <p className="text-slate-500 text-sm">{tipEn}</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(password);
          }}
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入密码 Enter password"
            className="w-full bg-slate-900/50 border border-slate-600 focus:border-purple-500 rounded-xl px-4 py-4 text-white text-center text-lg outline-none mb-4"
            autoFocus
          />
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl font-bold bg-slate-700 hover:bg-slate-600 text-white transition-all"
            >
              取消 Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-3 rounded-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white transition-all"
            >
              确认 Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ========== 恢复码弹窗 ==========
function RecoveryModal({ recoveryCode, onClose }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      alert("已复制恢复码！\nRecovery code copied!");
    } catch {
      alert("复制失败，请手动复制。\nCopy failed, please copy manually.");
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 max-w-md w-full">
        <div className="text-center mb-5">
          <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🧾</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">你的恢复码</h2>
          <p className="text-slate-300">Your Recovery Code</p>
          <p className="text-slate-400 mt-2">换设备或清理浏览器后，用它找回身份</p>
          <p className="text-slate-500 text-sm">Use it to restore your account on a new device</p>
        </div>

        <div className="bg-slate-900/50 border border-slate-600 rounded-xl px-4 py-4 text-center mb-4">
          <p className="text-3xl font-mono font-bold text-amber-300 tracking-widest">{recoveryCode}</p>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={copy}
            className="flex-1 py-3 rounded-xl font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 transition-all"
          >
            复制 Copy
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-xl font-bold bg-slate-700 hover:bg-slate-600 text-white transition-all"
          >
            我已保存 Saved
          </button>
        </div>
      </div>
    </div>
  );
}

// ========== 参与者加入页 ==========
function JoinPage({ data, participantId, onJoin, onBack }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const recognized =
    participantId && (data.registeredUsers || []).find((u) => u.participantId === participantId);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
        <button onClick={onBack} className="text-slate-400 hover:text-white mb-6 flex items-center gap-2">
          ← 返回 Back
        </button>

        <div className="text-center mb-7">
          <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">👤</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">加入答题</h2>
          <p className="text-slate-300">Join Quiz</p>

          {recognized && (
            <div className="mt-4 p-4 rounded-xl bg-green-500/10 border border-green-500/30 text-left">
              <p className="text-green-300 font-semibold">已识别你的设备 Device recognized</p>
              <p className="text-slate-300 mt-1">
                你是：<span className="font-semibold text-white">{recognized.userName}</span>
              </p>
              <p className="text-slate-500 text-sm mt-1">
                你可以直接进入，不需要恢复码。 You can enter directly.
              </p>
              <button
                onClick={() => onJoin({ userName: recognized.userName, recoveryCode: "" })}
                className="mt-4 w-full py-3 rounded-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white transition-all"
              >
                直接进入 Enter Now
              </button>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-slate-400 text-sm mb-2 block">昵称 Nickname</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError("");
              }}
              placeholder="请输入昵称 Enter nickname"
              className="w-full bg-slate-900/50 border border-slate-600 focus:border-indigo-500 rounded-xl px-4 py-3 text-white outline-none"
              maxLength={20}
            />
          </div>

          <div>
            <label className="text-slate-400 text-sm mb-2 block">恢复码（可选） Recovery Code (optional)</label>
            <input
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError("");
              }}
              placeholder="换设备找回用 / Use to restore on a new device"
              className="w-full bg-slate-900/50 border border-slate-600 focus:border-indigo-500 rounded-xl px-4 py-3 text-white outline-none font-mono"
              maxLength={12}
            />
            <p className="text-slate-500 text-xs mt-2">
              不填则创建新身份；填入则找回旧身份。 Leave empty to create new; enter to restore.
            </p>
          </div>

          {error && <p className="text-red-400 text-center text-sm">{error}</p>}

          <button
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              const res = await onJoin({ userName: name, recoveryCode: code });
              setLoading(false);
              if (!res.ok) setError(res.error);
            }}
            className="w-full py-4 rounded-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white transition-all disabled:opacity-50"
          >
            {loading ? "请稍候... Please wait..." : "进入 Enter"}
          </button>

          <div className="pt-3 text-center text-slate-500 text-xs">
            总用户 Total Users：<span className="text-slate-300">{(data.registeredUsers || []).length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ========== 答题页 ==========
function QuizPage({ data, participantId, userName, currentQuestion, onSubmit, onBack, finalRanking, myStats }) {
  const [selected, setSelected] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const hasSubmitted = useMemo(() => {
    if (!participantId || !currentQuestion) return false;
    return (data.submissions || []).some(
      (s) => s.participantId === participantId && s.questionId === currentQuestion.id
    );
  }, [data.submissions, participantId, currentQuestion]);

  // 计时器：从进入该题开始
  useEffect(() => {
    if (!participantId || !currentQuestion) return;
    if (data.quizStatus === "stopped") return;
    if (hasSubmitted) return;

    const key = `${participantId}_${currentQuestion.id}`;
    const startTime = data.questionStartTimes[key];
    if (!startTime) return;

    const t = setInterval(() => setElapsed(Date.now() - startTime), 100);
    return () => clearInterval(t);
  }, [participantId, currentQuestion?.id, data.questionStartTimes, data.quizStatus, hasSubmitted]);

  useEffect(() => {
    setSelected(null);
    setElapsed(0);
  }, [data.currentQuestionIndex]);

  // 停止后：显示最终结算页（参与者）
  if (data.quizStatus === "stopped") {
    const myRankIndex = finalRanking.findIndex((x) => x.participantId === participantId);
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <button onClick={onBack} className="text-slate-400 hover:text-white">
              ← 返回首页 Back to Home
            </button>
            <div className="bg-red-500/15 border border-red-500/30 rounded-full px-4 py-2 text-red-300 text-sm">
              已停止 Stopped
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 mb-6 text-center">
            <div className="text-5xl mb-4">🏁</div>
            <h2 className="text-2xl font-bold text-white mb-1">问卷已结束</h2>
            <p className="text-slate-300 mb-5">Quiz has ended</p>

            <div className="grid grid-cols-3 gap-4">
              <div className="bg-slate-900/40 rounded-xl p-4">
                <p className="text-slate-500 text-sm">用户 User</p>
                <p className="text-white font-semibold truncate">{userName || "Anonymous"}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4">
                <p className="text-slate-500 text-sm">答对 Correct</p>
                <p className="text-green-400 font-bold text-2xl">{myStats?.correctCount || 0}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4">
                <p className="text-slate-500 text-sm">正确总耗时 Correct Time</p>
                <p className="text-indigo-300 font-bold text-2xl">{formatMs(myStats?.totalCorrectTime || 0)}</p>
              </div>
            </div>

            <div className="mt-5 text-slate-400">
              <p>你的排名 Your Rank：<span className="text-white font-semibold">{myRankIndex >= 0 ? myRankIndex + 1 : "-"}</span></p>
              <p className="text-slate-500 text-sm">
                排序：答对题数优先，其次正确总耗时最短
                {" | "}
                Sorted by correct answers, then shortest total correct time
              </p>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-slate-700">
              <h3 className="text-xl font-bold text-white">🏆 最终排行榜 Final Leaderboard (Top 10)</h3>
            </div>
            {finalRanking.length === 0 ? (
              <div className="p-10 text-center text-slate-500">暂无数据 No data</div>
            ) : (
              <div className="divide-y divide-slate-700">
                {finalRanking.slice(0, 10).map((u, idx) => (
                  <div key={u.participantId} className={`p-4 flex items-center gap-4 ${u.participantId === participantId ? "bg-indigo-500/10" : ""}`}>
                    <div className="w-10 h-10 rounded-full bg-slate-700 text-slate-200 flex items-center justify-center font-bold">
                      {idx + 1}
                    </div>
                    <div className="flex-1">
                      <p className="text-white font-semibold">{u.userName}</p>
                      <p className="text-slate-500 text-sm">
                        答对 Correct {u.correctCount} · 正确总耗时 Correct Time {formatMs(u.totalCorrectTime)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 进行中但题目不存在：展示个人成绩（可选）
  if (!currentQuestion) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-1">题目已完成</h2>
          <p className="text-slate-300 mb-6">All questions completed</p>

          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 mb-6">
            <p className="text-slate-400 mb-4">你的成绩 Your Score</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-900/40 rounded-xl p-4">
                <p className="text-3xl font-bold text-green-400">{myStats?.correctCount || 0}</p>
                <p className="text-slate-500 text-sm">答对 Correct</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4">
                <p className="text-3xl font-bold text-indigo-300">{formatMs(myStats?.totalCorrectTime || 0)}</p>
                <p className="text-slate-500 text-sm">正确总耗时 Correct Time</p>
              </div>
            </div>
          </div>

          <button onClick={onBack} className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl">
            返回首页 Back to Home
          </button>
        </div>
      </div>
    );
  }

  const key = `${participantId}_${currentQuestion.id}`;
  const startTime = data.questionStartTimes[key];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="text-slate-400 hover:text-white">
            ← 退出 Exit
          </button>
          <div className="flex items-center gap-3">
            {!hasSubmitted && startTime && (
              <div className="bg-amber-500/20 border border-amber-500/30 rounded-full px-4 py-2 flex items-center gap-2">
                <span className="text-amber-400">⏱</span>
                <span className="text-amber-300 font-mono font-bold">{formatMs(elapsed)}</span>
              </div>
            )}
            <div className="bg-slate-800/50 border border-slate-700 rounded-full px-4 py-2 flex items-center gap-2">
              <span className="text-white font-medium">{userName || "Anonymous"}</span>
            </div>
          </div>
        </div>

        {hasSubmitted && (
          <div className="mb-6 p-4 bg-indigo-500/10 border border-indigo-500/30 rounded-xl flex items-center gap-3">
            <span className="text-xl">🔒</span>
            <div>
              <p className="text-indigo-300 font-medium">已提交本题答案 Answer Submitted</p>
              <p className="text-indigo-400/70 text-sm">请等待管理员开启下一题 Waiting for next question...</p>
            </div>
          </div>
        )}

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
          <div className="flex items-center gap-2 mb-6">
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold px-3 py-1 rounded-full">
              第 {data.currentQuestionIndex + 1} / {allQuestions.length} 题 | Q{data.currentQuestionIndex + 1} of {allQuestions.length}
            </span>
          </div>

          <h2 className="text-xl font-bold text-white mb-8 whitespace-pre-line">{currentQuestion.question}</h2>

          <div className="space-y-4 mb-8">
            {currentQuestion.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => !hasSubmitted && setSelected(opt.id)}
                disabled={hasSubmitted}
                className={`w-full p-4 rounded-xl border-2 text-left flex items-center gap-4 transition-all ${
                  hasSubmitted
                    ? selected === opt.id
                      ? "border-green-500 bg-green-500/10"
                      : "border-slate-700 bg-slate-800/30 opacity-50"
                    : selected === opt.id
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-slate-700 hover:border-slate-600 bg-slate-800/30"
                }`}
              >
                <span
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                    selected === opt.id ? "bg-indigo-500 text-white" : "bg-slate-700 text-slate-400"
                  }`}
                >
                  {opt.id}
                </span>
                <span className="text-slate-200 font-medium">{opt.text}</span>
              </button>
            ))}
          </div>

          {hasSubmitted ? (
            <div className="flex items-center justify-center gap-2 py-4 bg-green-500/10 border border-green-500/30 rounded-xl text-green-400">
              <span>✓</span> 已成功提交答案 Answer Submitted Successfully
            </div>
          ) : (
            <button
              onClick={() => onSubmit(selected)}
              disabled={!selected || !participantId}
              className={`w-full py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${
                selected
                  ? "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white"
                  : "bg-slate-700 text-slate-500 cursor-not-allowed"
              }`}
            >
              提交答案 Submit Answer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== 管理页 ==========
function AdminPage({ data, finalRanking, onNextQuestion, onStopQuiz, onResetAndStart, onBack }) {
  const currentQ = allQuestions[data.currentQuestionIndex];
  const isLastQuestion = data.currentQuestionIndex >= allQuestions.length - 1;

  const currentSubmissions = useMemo(() => {
    if (!currentQ) return [];
    return (data.submissions || []).filter((s) => s.questionId === currentQ.id);
  }, [data.submissions, currentQ]);

  const fastestCorrect = useMemo(() => {
    const correctSubs = currentSubmissions.filter((s) => s.isCorrect);
    if (correctSubs.length === 0) return null;
    return [...correctSubs].sort((a, b) => (a.duration || 0) - (b.duration || 0))[0];
  }, [currentSubmissions]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <button onClick={onBack} className="text-slate-400 hover:text-white">
            ← 返回首页 Back to Home
          </button>
          <div className="flex items-center gap-3">
            <div className="bg-slate-800/50 border border-slate-700 rounded-full px-4 py-2 text-slate-300 text-sm">
              状态 Status：{" "}
              <span className={data.quizStatus === "stopped" ? "text-red-300 font-semibold" : "text-indigo-300 font-semibold"}>
                {data.quizStatus === "stopped" ? "已停止 Stopped" : "进行中 Running"}
              </span>
            </div>
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">📊 管理看板</h1>
          <p className="text-slate-300">Admin Dashboard</p>
          <p className="text-slate-400 mt-1">控制节奏 · 可停止并最终结算</p>
          <p className="text-slate-500 text-sm">Control pace · Stop & settle final results</p>
        </div>

        {/* 当前题目 */}
        <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 mb-6">
          <span className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold px-3 py-1 rounded-full">
            当前 Current：第 {data.currentQuestionIndex + 1} / {allQuestions.length} 题 | Q{data.currentQuestionIndex + 1} of {allQuestions.length}
          </span>
          <p className="text-white text-lg mt-4 whitespace-pre-line">
            {currentQ ? currentQ.question : "所有题目已完成 All questions completed"}
          </p>
          {currentQ && <p className="text-green-400 text-sm mt-2">正确答案 Correct Answer: {currentQ.correctAnswer}</p>}
        </div>

        {/* 操作按钮 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <button
            onClick={onNextQuestion}
            disabled={data.quizStatus === "stopped" || isLastQuestion || !currentQ}
            className={`p-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
              data.quizStatus === "stopped" || isLastQuestion || !currentQ
                ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white"
            }`}
          >
            ⏭ {isLastQuestion ? "最后一题 Last" : "下一题 Next"}
          </button>

          <button
            onClick={onStopQuiz}
            disabled={data.quizStatus === "stopped"}
            className={`p-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
              data.quizStatus === "stopped"
                ? "bg-red-500/10 text-red-300/50 border border-red-500/20 cursor-not-allowed"
                : "bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30"
            }`}
          >
            🛑 停止并结算 Stop & Settle
          </button>

          <button
            onClick={onResetAndStart}
            className="p-4 rounded-xl font-bold flex items-center justify-center gap-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30"
          >
            🔄 重置并开启 Reset & Start
          </button>
        </div>

        {/* 统计 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">本题已提交</p>
            <p className="text-slate-500 text-xs">Submitted</p>
            <p className="text-3xl font-bold text-white">{currentSubmissions.length}</p>
          </div>

          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">本题最快答对</p>
            <p className="text-slate-500 text-xs">Fastest correct</p>
            <p className="text-xl font-bold text-amber-300">{fastestCorrect ? fastestCorrect.userName : "-"}</p>
            <p className="text-slate-500 text-xs mt-1">{fastestCorrect ? formatMs(fastestCorrect.duration || 0) : ""}</p>
          </div>

          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">总用户</p>
            <p className="text-slate-500 text-xs">Total Users</p>
            <p className="text-3xl font-bold text-white">{(data.registeredUsers || []).length}</p>
          </div>
        </div>

        {/* 最终排行榜 */}
        <div className="bg-slate-800/50 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="p-6 border-b border-slate-700 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">🏆 最终排行榜 Final Leaderboard</h2>
              <p className="text-slate-400 text-sm">
                答对数优先，其次正确总耗时最短 | Sorted by correct answers, then shortest total correct time
              </p>
            </div>
            <div className="text-slate-400 text-sm">
              状态 Status：{" "}
              <span className={data.quizStatus === "stopped" ? "text-red-300 font-semibold" : "text-indigo-300 font-semibold"}>
                {data.quizStatus === "stopped" ? "已停止 Stopped" : "进行中 Running"}
              </span>
            </div>
          </div>

          {finalRanking.length === 0 ? (
            <div className="p-12 text-center text-slate-500">暂无数据 No data yet</div>
          ) : (
            <div className="divide-y divide-slate-700">
              {finalRanking.slice(0, 20).map((u, idx) => (
                <div key={u.participantId} className={`p-4 flex items-center gap-4 ${idx < 3 ? "bg-slate-800/30" : ""}`}>
                  <div className="w-12 h-12 rounded-full bg-slate-700 text-slate-200 flex items-center justify-center font-bold text-lg">
                    {idx + 1}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-white text-lg">{u.userName}</p>
                    <p className="text-slate-400 text-sm">
                      答对 Correct {u.correctCount} · 正确总耗时 Correct Time {formatMs(u.totalCorrectTime)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 本题提交列表 */}
        <div className="mt-8 bg-slate-800/50 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="p-6 border-b border-slate-700">
            <h2 className="text-xl font-bold text-white">📋 本题提交详情 Current Submissions</h2>
            <p className="text-slate-400 text-sm">按提交时间排序 | Sorted by submission time</p>
          </div>

          {currentSubmissions.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p>等待用户提交...</p>
              <p className="text-sm">Waiting for submissions...</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-700">
              {currentSubmissions.slice(0, 30).map((s, idx) => (
                <div key={s.id} className={`p-4 flex items-center gap-4 ${idx < 3 ? "bg-slate-800/30" : ""}`}>
                  <div className="w-10 h-10 rounded-full bg-slate-700 text-slate-200 flex items-center justify-center font-bold">
                    {idx + 1}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-white">{s.userName}</p>
                    <p className="text-slate-400 text-sm">
                      选择 {s.answer} · 用时 {formatMs(s.duration || 0)}
                      {s.isCorrect ? <span className="text-green-400 ml-2">✓ 正确</span> : <span className="text-red-400 ml-2">✗ 错误</span>}
                    </p>
                  </div>
                  <p className="text-slate-300 font-mono text-sm">{s.time}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== 渲染 ==========
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

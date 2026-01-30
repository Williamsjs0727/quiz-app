
import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { db } from "./firebase";
import { ref, onValue, set, update } from "firebase/database";

// ========== 全局配置 ==========
const ADMIN_PASSWORD = "ennebei";
const LS_PARTICIPANT_ID = "quiz_participant_id"; // LocalStorage Key

// ========== 题目数据 ==========
const allQuestions = [
  {
    id: 1,
    question: "以下哪个是 JavaScript 的原始数据类型？\nWhich of the following is a primitive data type in JavaScript?",
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
    question: "React 中，以下哪个 Hook 用于处理副作用？\nIn React, which Hook is used to handle side effects?",
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
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function generateRecoveryCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor((ms % 1000) / 100);
  return `${s}.${d}s`;
}

const initialData = {
  quizStatus: "running",
  currentQuestionIndex: 0,
  registeredUsers: [],
  submissions: [],
  questionStartTimes: {},
};

// ========== 主应用 ==========
function App() {
  const [page, setPage] = useState("entry");
  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);
  
  // 当前用户状态
  const [participantId, setParticipantId] = useState("");
  const [currentUserName, setCurrentUserName] = useState("");
  
  // 弹窗状态
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [newRecoveryCode, setNewRecoveryCode] = useState("");

  // 1. 初始化：连接 Firebase
  useEffect(() => {
    const dataRef = ref(db, "/");
    const unsubscribe = onValue(dataRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        setData({
          quizStatus: val.quizStatus || "running",
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

  // 2. 身份识别：检查 LocalStorage
  // 只要本地有 ID，就自动登录，绝不生成新 ID
  useEffect(() => {
    const savedId = localStorage.getItem(LS_PARTICIPANT_ID);
    if (!savedId) return;

    // 等待 data 加载完毕
    if (data.registeredUsers && data.registeredUsers.length > 0) {
      const existingUser = data.registeredUsers.find(u => u.participantId === savedId);
      if (existingUser) {
        setParticipantId(existingUser.participantId);
        setCurrentUserName(existingUser.userName);
        // 如果还在入口页，且没在看其他弹窗，直接进入答题页
        if (page === "entry" || page === "register") {
          setPage("quiz");
        }
      }
    }
  }, [data.registeredUsers, page]);

  // ========== 核心逻辑：用户加入/恢复 ==========
  const handleJoin = async ({ userName, recoveryCode }) => {
    const trimmedName = userName.trim();
    if (!trimmedName) return { ok: false, error: "请输入昵称 Please enter nickname" };

    const inputCode = recoveryCode ? recoveryCode.trim().toUpperCase() : "";

    // A. 使用恢复码找回旧账号 (优先级最高)
    if (inputCode) {
      const foundUser = (data.registeredUsers || []).find(u => u.recoveryCode === inputCode);
      if (!foundUser) return { ok: false, error: "恢复码无效 Invalid recovery code" };

      // 找回成功：写入本地，恢复身份
      localStorage.setItem(LS_PARTICIPANT_ID, foundUser.participantId);
      setParticipantId(foundUser.participantId);
      setCurrentUserName(foundUser.userName); 
      setPage("quiz");
      return { ok: true };
    }

    // B. 新用户注册 - 【检查重名】
    const nameExists = (data.registeredUsers || []).some(
      u => u.userName.toLowerCase() === trimmedName.toLowerCase()
    );

    if (nameExists) {
      return { ok: false, error: "该昵称已被使用，请换一个。\nNickname already taken." };
    }

    // 生成永久 ID 和 恢复码
    const newId = generateId();
    const newCode = generateRecoveryCode();
    
    const newUser = {
      participantId: newId,
      userName: trimmedName,
      recoveryCode: newCode,
      createdAt: Date.now(),
    };

    const updatedUsers = [...(data.registeredUsers || []), newUser];
    await update(ref(db, "/"), { registeredUsers: updatedUsers });

    // 写入本地
    localStorage.setItem(LS_PARTICIPANT_ID, newId);
    setParticipantId(newId);
    setCurrentUserName(trimmedName);
    
    // 注册完先弹窗显示 Code
    setNewRecoveryCode(newCode);
    setShowRecoveryModal(true);
    
    return { ok: true };
  };

  // 关闭恢复码弹窗 -> 进入答题
  const handleCloseRecoveryModal = () => {
    setShowRecoveryModal(false);
    setPage("quiz");
  };

  // ========== 核心逻辑：答题计时与提交 ==========
  const currentQuestion = allQuestions[data.currentQuestionIndex];

  // 记录开始时间（仅当进入 Quiz 页且题目未回答时）
  useEffect(() => {
    if (page !== "quiz" || !participantId || !currentQuestion) return;
    
    const key = `${participantId}_${currentQuestion.id}`;
    
    // 检查是否已提交过，提交过就不再重新计时
    const isDone = (data.submissions || []).some(
      s => s.participantId === participantId && s.questionId === currentQuestion.id
    );
    if (isDone) return;

    // 如果还没有开始时间，则写入
    if (!data.questionStartTimes[key]) {
      update(ref(db, `/questionStartTimes`), { [key]: Date.now() });
    }
  }, [page, participantId, currentQuestion, data.submissions, data.questionStartTimes]);

  const handleSubmit = async (answer) => {
    // 防重复提交：再次检查 DB 中是否已有记录
    const isAlreadySubmitted = (data.submissions || []).some(
      s => s.participantId === participantId && s.questionId === currentQuestion.id
    );
    if (isAlreadySubmitted) return;

    const key = `${participantId}_${currentQuestion.id}`;
    const startTime = data.questionStartTimes[key] || Date.now();
    const submitTime = Date.now();
    const duration = submitTime - startTime;

    const newSub = {
      id: generateId(),
      participantId,
      userName: currentUserName,
      questionId: currentQuestion.id,
      answer,
      isCorrect: answer === currentQuestion.correctAnswer,
      duration,
      submitTime,
    };

    const newSubmissions = [...(data.submissions || []), newSub];
    await update(ref(db, "/"), { submissions: newSubmissions });
  };

  // ========== 管理员操作 ==========
  const handleAdminAuth = (pwd) => {
    if (pwd === ADMIN_PASSWORD) {
      setShowAdminModal(false);
      setPage("admin");
    } else {
      alert("密码错误 Error");
    }
  };

  const handleNextQ = async () => {
    if (data.currentQuestionIndex < allQuestions.length - 1) {
      await update(ref(db, "/"), { currentQuestionIndex: data.currentQuestionIndex + 1 });
    }
  };

  const handleStop = async () => {
    if (window.confirm("停止问卷？Stop quiz?")) {
      await update(ref(db, "/"), { quizStatus: "stopped" });
    }
  };

  const handleReset = async () => {
    if (window.confirm("⚠️ 危险：重置所有数据？Reset ALL data?")) {
      await set(ref(db, "/"), initialData);
      localStorage.removeItem(LS_PARTICIPANT_ID);
      window.location.reload();
    }
  };

  // 渲染分发
  return (
    <div className="min-h-screen bg-slate-900 text-white font-sans selection:bg-indigo-500 selection:text-white">
      {/* 恢复码弹窗（注册成功后显示） */}
      {showRecoveryModal && (
        <RecoveryCodeModal code={newRecoveryCode} onClose={handleCloseRecoveryModal} />
      )}

      {/* 管理员密码弹窗 */}
      {showAdminModal && (
        <PasswordModal onClose={() => setShowAdminModal(false)} onSubmit={handleAdminAuth} />
      )}

      {/* 页面路由 */}
      {page === "entry" && (
        <EntryPage 
          isConnected={isConnected} 
          onStart={() => setPage("register")} 
          onAdmin={() => setShowAdminModal(true)}
          currentUser={participantId ? currentUserName : null}
          onContinue={() => setPage("quiz")} // 自动识别的用户直接进
        />
      )}

      {page === "register" && (
        <RegisterPage 
          onJoin={handleJoin} 
          onBack={() => setPage("entry")} 
        />
      )}

      {page === "quiz" && (
        <QuizPage 
          data={data} 
          participantId={participantId} 
          currentUserName={currentUserName} 
          currentQuestion={currentQuestion}
          onSubmit={handleSubmit}
          onBack={() => setPage("entry")}
        />
      )}

      {page === "admin" && (
        <AdminPage 
          data={data} 
          onNext={handleNextQ}
          onStop={handleStop}
          onReset={handleReset}
          onBack={() => setPage("entry")}
        />
      )}
    </div>
  );
}

// ========== 子组件：恢复码弹窗 (新) ==========
function RecoveryCodeModal({ code, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-8 max-w-sm w-full text-center shadow-2xl animate-in fade-in zoom-in duration-300">
        <div className="text-4xl mb-4">🔐</div>
        <h3 className="text-2xl font-bold text-white mb-2">保存你的恢复码</h3>
        <p className="text-slate-400 mb-6 text-sm">Save your Recovery Code</p>
        
        <div className="bg-slate-950 rounded-xl p-4 mb-2 border border-indigo-500/30">
          <p className="text-3xl font-mono font-bold text-indigo-400 tracking-widest select-all">{code}</p>
        </div>
        <p className="text-slate-500 text-xs mb-8">换设备或意外退出时，用它找回身份</p>
        
        <button 
          onClick={onClose}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold transition-all"
        >
          我记住了 I Saved It
        </button>
      </div>
    </div>
  );
}

// ========== 子组件：入口页 ==========
function EntryPage({ isConnected, onStart, onAdmin, currentUser, onContinue }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900">
      <div className="mb-8 flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-400">
        <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-yellow-500 animate-pulse"}`}></span>
        {isConnected ? "System Online" : "Connecting..."}
      </div>

      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold text-white mb-4 tracking-tight">Real-time Quiz</h1>
        <p className="text-slate-400 text-lg">实时互动答题系统</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 w-full max-w-2xl">
        {currentUser ? (
          <button onClick={onContinue} className="bg-indigo-600 hover:bg-indigo-500 text-white p-8 rounded-2xl text-left transition-all border border-indigo-500 shadow-lg shadow-indigo-900/20 group">
            <div className="text-3xl mb-4">👋</div>
            <h2 className="text-2xl font-bold mb-1">欢迎回来, {currentUser}</h2>
            <p className="text-indigo-200">点击继续答题 Continue Quiz</p>
            <div className="mt-4 flex items-center text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity">进入 Enter →</div>
          </button>
        ) : (
          <button onClick={onStart} className="bg-slate-800 hover:bg-slate-700 text-white p-8 rounded-2xl text-left transition-all border border-slate-700 hover:border-indigo-500 group">
            <div className="text-3xl mb-4">👤</div>
            <h2 className="text-2xl font-bold mb-1">参与答题</h2>
            <p className="text-slate-400">Join Quiz</p>
            <div className="mt-4 flex items-center text-indigo-400 text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity">进入 Enter →</div>
          </button>
        )}

        <button onClick={onAdmin} className="bg-slate-800 hover:bg-slate-700 text-white p-8 rounded-2xl text-left transition-all border border-slate-700 hover:border-purple-500 group">
          <div className="text-3xl mb-4">📊</div>
          <h2 className="text-2xl font-bold mb-1">管理员</h2>
          <p className="text-slate-400">Admin Dashboard</p>
          <div className="mt-4 flex items-center text-purple-400 text-sm font-bold opacity-0 group-hover:opacity-100 transition-opacity">进入 Enter →</div>
        </button>
      </div>
    </div>
  );
}

// ========== 子组件：注册页 ==========
function RegisterPage({ onJoin, onBack }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    const res = await onJoin({ userName: name, recoveryCode: code });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-slate-800 rounded-2xl p-8 border border-slate-700">
        <button onClick={onBack} className="text-slate-400 mb-6 hover:text-white">← Back</button>
        <h2 className="text-2xl font-bold text-white mb-6">输入信息 Enter Info</h2>
        
        <div className="space-y-4">
          <div>
            <label className="text-slate-400 text-sm block mb-2">昵称 Nickname</label>
            <input 
              value={name} onChange={e => { setName(e.target.value); setError(""); }}
              className="w-full bg-slate-900 border border-slate-600 rounded-xl p-4 text-white focus:border-indigo-500 outline-none"
              placeholder="e.g. SHI"
            />
          </div>
          <div>
            <label className="text-slate-400 text-sm block mb-2">恢复码 Recovery Code (选填)</label>
            <input 
              value={code} onChange={e => { setCode(e.target.value); setError(""); }}
              className="w-full bg-slate-900 border border-slate-600 rounded-xl p-4 text-white focus:border-indigo-500 outline-none font-mono"
              placeholder="仅旧用户填写 Only for returning users"
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button 
            onClick={handleSubmit} 
            disabled={loading || !name}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl mt-4"
          >
            {loading ? "..." : "进入 Enter"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ========== 子组件：答题页 ==========
function QuizPage({ data, participantId, currentUserName, currentQuestion, onSubmit, onBack }) {
  const [selected, setSelected] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  // 检查当前题是否已答
  const mySubmission = (data.submissions || []).find(
    s => s.participantId === participantId && s.questionId === currentQuestion?.id
  );
  
  const hasSubmitted = !!mySubmission;

  // 计时器逻辑
  useEffect(() => {
    if (!currentQuestion || hasSubmitted || data.quizStatus === "stopped") return;
    
    const key = `${participantId}_${currentQuestion.id}`;
    const startTime = data.questionStartTimes[key];
    
    if (startTime) {
      const timer = setInterval(() => {
        setElapsed(Date.now() - startTime);
      }, 100);
      return () => clearInterval(timer);
    }
  }, [currentQuestion, hasSubmitted, participantId, data.questionStartTimes, data.quizStatus]);

  useEffect(() => {
    setSelected(null);
    setElapsed(0);
  }, [data.currentQuestionIndex]);

  // A. 问卷停止或全部完成
  if (data.quizStatus === "stopped" || !currentQuestion) {
    // 简单计算个人成绩
    const mySubs = (data.submissions || []).filter(s => s.participantId === participantId);
    const correctCount = mySubs.filter(s => s.isCorrect).length;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <div className="text-6xl mb-4">🏁</div>
          <h2 className="text-3xl font-bold mb-2">
            {data.quizStatus === "stopped" ? "已停止 Stopped" : "全部完成 Completed"}
          </h2>
          <div className="bg-slate-800 p-6 rounded-2xl mt-6 border border-slate-700">
            <p className="text-slate-400 text-sm uppercase tracking-wider">Your Score</p>
            <div className="text-4xl font-bold text-white mt-2">{correctCount} <span className="text-lg text-slate-500">/ {allQuestions.length}</span></div>
          </div>
          <button onClick={onBack} className="mt-8 text-slate-400 hover:text-white">Back to Home</button>
        </div>
      </div>
    );
  }

  // B. 正常答题
  return (
    <div className="min-h-screen p-6 max-w-2xl mx-auto flex flex-col justify-center">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-2">
           <span className="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center font-bold text-sm">
             {currentUserName ? currentUserName[0].toUpperCase() : "?"}
           </span>
           <span className="font-bold">{currentUserName}</span>
        </div>
        {!hasSubmitted && (
          <div className="font-mono text-xl font-bold text-amber-400">
            {formatMs(elapsed)}
          </div>
        )}
      </div>

      <div className="bg-slate-800 p-8 rounded-3xl border border-slate-700 shadow-2xl relative overflow-hidden">
        {/* 顶部进度条 */}
        <div className="absolute top-0 left-0 h-1 bg-indigo-600 transition-all duration-500" style={{ width: `${((data.currentQuestionIndex + 1) / allQuestions.length) * 100}%` }}></div>

        <span className="inline-block bg-slate-700 text-slate-300 text-xs font-bold px-3 py-1 rounded-full mb-6">
          QUESTION {data.currentQuestionIndex + 1} OF {allQuestions.length}
        </span>
        
        <h2 className="text-xl md:text-2xl font-bold mb-8 whitespace-pre-line leading-relaxed">
          {currentQuestion.question}
        </h2>

        <div className="space-y-3">
          {currentQuestion.options.map(opt => {
            // 样式逻辑
            let btnClass = "w-full p-4 rounded-xl border-2 text-left font-medium transition-all flex items-center gap-3 ";
            if (hasSubmitted) {
              if (mySubmission.answer === opt.id) {
                btnClass += mySubmission.isCorrect 
                  ? "border-green-500 bg-green-500/10 text-green-400" 
                  : "border-red-500 bg-red-500/10 text-red-400";
              } else {
                btnClass += "border-slate-700 opacity-50";
              }
            } else {
              if (selected === opt.id) {
                btnClass += "border-indigo-500 bg-indigo-500/10 text-indigo-300";
              } else {
                btnClass += "border-slate-700 hover:border-slate-600 hover:bg-slate-700/50";
              }
            }

            return (
              <button 
                key={opt.id}
                onClick={() => !hasSubmitted && setSelected(opt.id)}
                disabled={hasSubmitted}
                className={btnClass}
              >
                <span className="w-6 h-6 rounded-full border border-current flex items-center justify-center text-xs font-bold opacity-70">
                  {opt.id}
                </span>
                {opt.text}
              </button>
            )
          })}
        </div>

        {hasSubmitted ? (
          <div className="mt-6 p-4 bg-slate-900/50 rounded-xl text-center text-slate-400 text-sm animate-pulse">
            等待下一题 Waiting for next question...
          </div>
        ) : (
          <button 
            onClick={() => onSubmit(selected)}
            disabled={!selected}
            className="w-full mt-8 py-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-900/50"
          >
            提交 Submit
          </button>
        )}
      </div>
    </div>
  );
}

// ========== 子组件：管理员看板 ==========
function AdminPage({ data, onNext, onStop, onReset, onBack }) {
  const currentQ = allQuestions[data.currentQuestionIndex];
  
  // 筛选本题提交
  const currentSubs = (data.submissions || [])
    .filter(s => s.questionId === currentQ?.id)
    .sort((a, b) => a.submitTime - b.submitTime); // 按提交时间排序，但显示耗时

  return (
    <div className="min-h-screen p-6 bg-slate-900">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <button onClick={onBack} className="text-slate-400 hover:text-white">← Exit</button>
          <div className="flex gap-4">
            <button onClick={onStop} className="px-4 py-2 bg-slate-800 hover:bg-red-900/30 text-red-400 rounded-lg text-sm font-bold border border-slate-700 hover:border-red-500/50 transition-all">
              ⏹ 停止 Stop
            </button>
            <button onClick={onReset} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm border border-slate-700 transition-all">
              🔄 重置 Reset
            </button>
          </div>
        </div>

        {/* 控制区 */}
        <div className="bg-slate-800 p-6 rounded-2xl border border-slate-700 mb-8 flex flex-col md:flex-row gap-6 items-center justify-between">
          <div>
            <span className="text-indigo-400 text-xs font-bold tracking-wider uppercase mb-1 block">Current Question</span>
            <h2 className="text-xl font-bold text-white max-w-lg truncate">
              {currentQ ? `Q${currentQ.id}: ${currentQ.question}` : "Done"}
            </h2>
            {currentQ && <p className="text-green-400 text-sm mt-1 font-mono">Answer: {currentQ.correctAnswer}</p>}
          </div>
          <button 
            onClick={onNext}
            disabled={!currentQ || data.quizStatus === "stopped"}
            className="px-8 py-4 bg-white text-slate-900 hover:bg-indigo-50 font-bold rounded-xl shadow-lg shadow-white/10 transition-all disabled:opacity-50"
          >
            下一题 Next →
          </button>
        </div>

        {/* 提交列表 */}
        <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="p-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
            <h3 className="font-bold text-white">📋 实时提交 Live Submissions</h3>
            <span className="text-sm text-slate-400">{currentSubs.length} entries</span>
          </div>
          
          {currentSubs.length === 0 ? (
            <div className="p-12 text-center text-slate-600">Waiting for answers...</div>
          ) : (
            <div className="divide-y divide-slate-700/50">
              {currentSubs.map((sub, idx) => (
                <div key={sub.id} className="p-4 flex items-center justify-between hover:bg-slate-700/20 transition-colors">
                  <div className="flex items-center gap-4">
                    <span className={`w-8 h-8 flex items-center justify-center rounded-lg font-bold text-sm ${idx < 3 ? "bg-amber-500 text-slate-900" : "bg-slate-700 text-slate-400"}`}>
                      {idx + 1}
                    </span>
                    <div>
                      <div className="font-bold text-white text-lg">{sub.userName}</div>
                      <div className="text-xs text-slate-500">
                        {/* 这里不再显示具体时间，只显示选项 */}
                        Selected: <span className="font-mono text-slate-300">{sub.answer}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-right">
                    {/* 重点修改：只显示耗时 duration */}
                    <div className="font-mono text-xl font-bold text-indigo-400">
                      {formatMs(sub.duration)}
                    </div>
                    {/* 对错图标 */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-lg ${sub.isCorrect ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                      {sub.isCorrect ? "✓" : "✗"}
                    </div>
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

// 通用密码框
function PasswordModal({ onClose, onSubmit }) {
  const [val, setVal] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
      <div className="bg-slate-800 p-8 rounded-2xl w-full max-w-sm border border-slate-700">
        <h3 className="text-xl font-bold text-white mb-4 text-center">Admin Password</h3>
        <input 
          type="password" 
          autoFocus
          className="w-full bg-slate-900 border border-slate-600 rounded-xl p-4 text-center text-white mb-4 outline-none focus:border-indigo-500"
          onChange={e => setVal(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-3 bg-slate-700 text-white rounded-xl">Cancel</button>
          <button onClick={() => onSubmit(val)} className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold">Login</button>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

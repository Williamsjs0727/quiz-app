
import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import { db } from "./firebase";
import { ref, onValue, set, update } from "firebase/database";

// ========== 管理员密码 ==========
const ADMIN_PASSWORD = "ennebei";

// ========== 题目数据（含正确答案） ==========
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

const initialData = {
  currentQuestionIndex: 0,
  registeredUsers: [],
  submissions: [],
  questionStartTimes: {},
};

// ========== 主应用 ==========
function App() {
  const [page, setPage] = useState("entry");
  const [currentUser, setCurrentUser] = useState("");
  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [localStartTime, setLocalStartTime] = useState(null);

  useEffect(() => {
    const dataRef = ref(db, "/");
    const unsubscribe = onValue(dataRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        setData({
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

  // 当进入答题页面或题目切换时，记录开始时间
  useEffect(() => {
    if (page === "quiz" && currentUser) {
      const currentQ = allQuestions[data.currentQuestionIndex];
      if (currentQ) {
        const key = `${currentUser}_${currentQ.id}`;
        const existingStartTime = data.questionStartTimes[key];
        
        // 如果这道题还没有开始时间，记录当前时间
        if (!existingStartTime) {
          const now = Date.now();
          setLocalStartTime(now);
          update(ref(db, "/questionStartTimes"), { [key]: now });
        } else {
          setLocalStartTime(existingStartTime);
        }
      }
    }
  }, [page, currentUser, data.currentQuestionIndex]);

  const handleRegister = async (userName, password) => {
    const existingUser = data.registeredUsers.find(u => u.userName === userName);
    
    if (existingUser) {
      // 用户已存在，验证密码
      if (existingUser.password !== password) {
        return { success: false, error: "密码错误 Incorrect password" };
      }
      // 密码正确，登录成功
      setCurrentUser(userName);
      setPage("quiz");
      return { success: true };
    } else {
      // 新用户注册
      const newUser = { userName, password, registeredAt: Date.now() };
      const newUsers = [...(data.registeredUsers || []), newUser];
      await update(ref(db, "/"), { registeredUsers: newUsers });
      setCurrentUser(userName);
      setPage("quiz");
      return { success: true };
    }
  };

  const handleSubmit = async (userName, answer, questionId) => {
    const currentQ = allQuestions.find(q => q.id === questionId);
    const isCorrect = currentQ && answer === currentQ.correctAnswer;
    const key = `${userName}_${questionId}`;
    const startTime = data.questionStartTimes[key] || localStartTime || Date.now();
    const submitTime = Date.now();
    const duration = submitTime - startTime; // 毫秒

    const newSubmission = {
      id: Date.now(),
      userName,
      answer,
      questionId,
      isCorrect,
      startTime,
      submitTime,
      duration,
      time: new Date().toLocaleTimeString("zh-CN"),
    };
    const newSubmissions = [...(data.submissions || []), newSubmission];
    await update(ref(db, "/"), { submissions: newSubmissions });
  };

  const handleNextQuestion = async () => {
    if (data.currentQuestionIndex < allQuestions.length - 1) {
      await update(ref(db, "/"), { currentQuestionIndex: data.currentQuestionIndex + 1 });
    }
  };

  const handleReset = async () => {
    if (window.confirm("确定要重置所有数据吗？\nAre you sure you want to reset all data?")) {
      await set(ref(db, "/"), initialData);
      setPage("entry");
      setCurrentUser("");
      setLocalStartTime(null);
    }
  };

  const handleAdminClick = () => {
    setShowPasswordModal(true);
  };

  const handlePasswordSubmit = (password) => {
    if (password === ADMIN_PASSWORD) {
      setShowPasswordModal(false);
      setPage("admin");
    } else {
      alert("密码错误！\nIncorrect password!");
    }
  };

  // ===== 入口页面 =====
  if (page === "entry") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        {showPasswordModal && (
          <PasswordModal
            onSubmit={handlePasswordSubmit}
            onClose={() => setShowPasswordModal(false)}
          />
        )}
        <div className="max-w-2xl w-full">
          <div className="flex justify-center mb-6">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm ${isConnected ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"}`}>
              <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-400" : "bg-yellow-400 animate-pulse"}`}></span>
              {isConnected ? "已连接云端数据库 Connected to Cloud" : "连接中 Connecting..."}
            </div>
          </div>
          <div className="text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl mb-6 shadow-lg">
              <span className="text-4xl">✨</span>
            </div>
            <h1 className="text-4xl font-bold text-white mb-3">实时答题系统</h1>
            <p className="text-2xl text-slate-300 mb-2">Real-time Quiz System</p>
            <p className="text-slate-400 text-lg">全球实时同步 · 支持多设备接入</p>
            <p className="text-slate-500">Global Real-time Sync · Multi-device Support</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <button onClick={() => setPage("register")} className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-indigo-500 rounded-2xl p-8 text-left transition-all">
              <div className="w-14 h-14 bg-indigo-500/20 group-hover:bg-indigo-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">👤</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-1">参与答题</h2>
              <p className="text-slate-300 mb-2">Join Quiz</p>
              <p className="text-slate-400 mb-1">输入昵称和密码参与互动</p>
              <p className="text-slate-500 text-sm mb-4">Enter nickname & password to join</p>
              <div className="flex items-center text-indigo-400 font-medium">进入 Enter →</div>
            </button>
            <button onClick={handleAdminClick} className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-purple-500 rounded-2xl p-8 text-left transition-all">
              <div className="w-14 h-14 bg-purple-500/20 group-hover:bg-purple-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">📊</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-1">管理看板</h2>
              <p className="text-slate-300 mb-2">Admin Dashboard</p>
              <p className="text-slate-400 mb-1">控制题目与查看排名</p>
              <p className="text-slate-500 text-sm mb-4">Control questions & view rankings</p>
              <div className="flex items-center text-purple-400 font-medium">进入 Enter →</div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 注册/登录页面 =====
  if (page === "register") {
    return <RegisterPage data={data} onRegister={handleRegister} onBack={() => setPage("entry")} />;
  }

  // ===== 答题页面 =====
  if (page === "quiz") {
    return <QuizPage currentUser={currentUser} data={data} onSubmit={handleSubmit} onBack={() => setPage("entry")} localStartTime={localStartTime} />;
  }

  // ===== 管理页面 =====
  if (page === "admin") {
    return <AdminPage data={data} onNextQuestion={handleNextQuestion} onReset={handleReset} onBack={() => setPage("entry")} />;
  }

  return null;
}

// ========== 密码输入弹窗 ==========
function PasswordModal({ onSubmit, onClose }) {
  const [password, setPassword] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(password);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-purple-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🔐</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">管理员验证</h2>
          <p className="text-slate-300">Admin Verification</p>
          <p className="text-slate-400 mt-2">请输入管理员密码</p>
          <p className="text-slate-500 text-sm">Please enter admin password</p>
        </div>
        <form onSubmit={handleSubmit}>
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

// ========== 注册/登录页面组件 ==========
function RegisterPage({ data, onRegister, onBack }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const existingUser = data.registeredUsers.find(u => u.userName === name.trim());
  const isReturningUser = existingUser !== undefined;

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    const trimmedPassword = password.trim();
    
    if (!trimmedName) return setError("请输入昵称 Please enter a nickname");
    if (trimmedName.length < 2) return setError("昵称至少2个字符 Nickname must be at least 2 characters");
    if (!trimmedPassword) return setError("请输入密码 Please enter a password");
    if (trimmedPassword.length < 3) return setError("密码至少3个字符 Password must be at least 3 characters");
    
    setIsLoading(true);
    const result = await onRegister(trimmedName, trimmedPassword);
    setIsLoading(false);
    
    if (!result.success) {
      setError(result.error);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
        <button onClick={onBack} className="text-slate-400 hover:text-white mb-6 flex items-center gap-2">← 返回 Back</button>
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">{isReturningUser ? "👋" : "👤"}</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-1">
            {isReturningUser ? "欢迎回来！" : "注册参与"}
          </h2>
          <p className="text-slate-300 mb-2">
            {isReturningUser ? "Welcome Back!" : "Register to Join"}
          </p>
          <p className="text-slate-400">
            {isReturningUser ? "输入密码继续答题" : "设置昵称和密码"}
          </p>
          <p className="text-slate-500 text-sm">
            {isReturningUser ? "Enter your password to continue" : "Set your nickname and password"}
          </p>
        </div>
        
        <div className="space-y-4 mb-4">
          <div>
            <label className="text-slate-400 text-sm mb-2 block">昵称 Nickname</label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder="请输入昵称 Enter nickname"
              className="w-full bg-slate-900/50 border border-slate-600 focus:border-indigo-500 rounded-xl px-4 py-3 text-white outline-none"
              maxLength={10}
            />
            {isReturningUser && (
              <p className="text-green-400 text-sm mt-2 flex items-center gap-1">
                <span>✓</span> 已找到账户 Account found
              </p>
            )}
          </div>
          
          <div>
            <label className="text-slate-400 text-sm mb-2 block">
              {isReturningUser ? "密码 Password" : "设置密码 Set Password"}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder={isReturningUser ? "输入你的密码 Enter your password" : "设置一个密码 Set a password"}
              className="w-full bg-slate-900/50 border border-slate-600 focus:border-indigo-500 rounded-xl px-4 py-3 text-white outline-none"
              maxLength={20}
            />
            {!isReturningUser && (
              <p className="text-slate-500 text-xs mt-2">
                💡 退出后可用此密码重新登录 | Use this password to log back in
              </p>
            )}
          </div>
        </div>
        
        {error && <p className="text-red-400 text-center mb-4 text-sm">{error}</p>}
        
        {data.registeredUsers.length > 0 && (
          <div className="mb-6 p-4 bg-slate-900/30 rounded-xl">
            <p className="text-slate-500 text-sm mb-2">已有 {data.registeredUsers.length} 人参与 | {data.registeredUsers.length} participants</p>
            <div className="flex flex-wrap gap-2">
              {data.registeredUsers.slice(-5).map((u, i) => (
                <span key={i} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded-full">{u.userName}</span>
              ))}
            </div>
          </div>
        )}
        
        <button 
          onClick={handleSubmit} 
          disabled={isLoading}
          className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold py-4 rounded-xl transition-all disabled:opacity-50"
        >
          {isLoading ? "请稍候..." : isReturningUser ? "登录继续 Log In" : "注册并开始 Register & Start"}
        </button>
      </div>
    </div>
  );
}

// ========== 答题页面组件 ==========
function QuizPage({ currentUser, data, onSubmit, onBack, localStartTime }) {
  const [selected, setSelected] = useState(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const currentQ = allQuestions[data.currentQuestionIndex];
  const hasSubmitted = data.submissions.some((s) => s.userName === currentUser && s.questionId === currentQ?.id);

  // 计时器
  useEffect(() => {
    if (!currentQ || hasSubmitted) return;
    
    const key = `${currentUser}_${currentQ.id}`;
    const startTime = data.questionStartTimes[key] || localStartTime;
    
    if (!startTime) return;

    const interval = setInterval(() => {
      setElapsedTime(Date.now() - startTime);
    }, 100);

    return () => clearInterval(interval);
  }, [currentQ, hasSubmitted, currentUser, data.questionStartTimes, localStartTime]);

  useEffect(() => { 
    setSelected(null); 
    setElapsedTime(0);
  }, [data.currentQuestionIndex]);

  const formatTime = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const decimals = Math.floor((ms % 1000) / 100);
    return `${seconds}.${decimals}s`;
  };

  if (!currentQ) {
    // 计算该用户的总成绩
    const userSubmissions = data.submissions.filter(s => s.userName === currentUser);
    const correctCount = userSubmissions.filter(s => s.isCorrect).length;
    const totalTime = userSubmissions.reduce((sum, s) => sum + (s.duration || 0), 0);

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-1">所有题目已完成</h2>
          <p className="text-slate-300 mb-6">All Questions Completed</p>
          
          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 mb-6">
            <p className="text-slate-400 mb-4">你的成绩 Your Score</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-900/50 rounded-xl p-4">
                <p className="text-3xl font-bold text-green-400">{correctCount}/{allQuestions.length}</p>
                <p className="text-slate-500 text-sm">答对题数 Correct</p>
              </div>
              <div className="bg-slate-900/50 rounded-xl p-4">
                <p className="text-3xl font-bold text-indigo-400">{(totalTime / 1000).toFixed(1)}s</p>
                <p className="text-slate-500 text-sm">总用时 Total Time</p>
              </div>
            </div>
          </div>
          
          <p className="text-slate-400 mb-1">感谢你的参与！</p>
          <p className="text-slate-500 mb-6">Thank you for participating!</p>
          <button onClick={onBack} className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl">返回首页 Back to Home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="text-slate-400 hover:text-white">← 退出 Exit</button>
          <div className="flex items-center gap-3">
            {!hasSubmitted && (
              <div className="bg-amber-500/20 border border-amber-500/30 rounded-full px-4 py-2 flex items-center gap-2">
                <span className="text-amber-400">⏱</span>
                <span className="text-amber-300 font-mono font-bold">{formatTime(elapsedTime)}</span>
              </div>
            )}
            <div className="bg-slate-800/50 border border-slate-700 rounded-full px-4 py-2 flex items-center gap-2">
              <span className="text-white font-medium">{currentUser}</span>
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
          <h2 className="text-xl font-bold text-white mb-8 whitespace-pre-line">{currentQ.question}</h2>
          <div className="space-y-4 mb-8">
            {currentQ.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => !hasSubmitted && setSelected(opt.id)}
                disabled={hasSubmitted}
                className={`w-full p-4 rounded-xl border-2 text-left flex items-center gap-4 transition-all ${
                  hasSubmitted
                    ? selected === opt.id ? "border-green-500 bg-green-500/10" : "border-slate-700 bg-slate-800/30 opacity-50"
                    : selected === opt.id ? "border-indigo-500 bg-indigo-500/10" : "border-slate-700 hover:border-slate-600 bg-slate-800/30"
                }`}
              >
                <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                  selected === opt.id ? (hasSubmitted ? "bg-green-500 text-white" : "bg-indigo-500 text-white") : "bg-slate-700 text-slate-400"
                }`}>{opt.id}</span>
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
              onClick={() => onSubmit(currentUser, selected, currentQ.id)}
              disabled={!selected}
              className={`w-full py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${
                selected ? "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white" : "bg-slate-700 text-slate-500 cursor-not-allowed"
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

// ========== 管理页面组件 ==========
function AdminPage({ data, onNextQuestion, onReset, onBack }) {
  const [showFinalRanking, setShowFinalRanking] = useState(false);
  const currentQ = allQuestions[data.currentQuestionIndex];
  const currentSubmissions = data.submissions.filter((s) => s.questionId === currentQ?.id) || [];
  const isLastQuestion = data.currentQuestionIndex >= allQuestions.length - 1;

  // 计算最终排行榜
  const calculateFinalRanking = () => {
    const userStats = {};
    
    data.registeredUsers.forEach(user => {
      const userName = user.userName;
      const userSubmissions = data.submissions.filter(s => s.userName === userName);
      const correctCount = userSubmissions.filter(s => s.isCorrect).length;
      const totalTime = userSubmissions.reduce((sum, s) => sum + (s.duration || 0), 0);
      
      userStats[userName] = {
        userName,
        correctCount,
        totalTime,
        submissionCount: userSubmissions.length,
      };
    });

    // 排序：先按答对数降序，再按总时间升序
    return Object.values(userStats).sort((a, b) => {
      if (b.correctCount !== a.correctCount) {
        return b.correctCount - a.correctCount;
      }
      return a.totalTime - b.totalTime;
    });
  };

  const finalRanking = calculateFinalRanking();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <button onClick={onBack} className="text-slate-400 hover:text-white">← 返回首页 Back to Home</button>
          <div className="flex items-center gap-2 text-green-400">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
            <span className="text-sm">实时同步中 Syncing</span>
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">📊 管理看板</h1>
          <p className="text-slate-300">Admin Dashboard</p>
          <p className="text-slate-400 mt-1">全球实时同步 · 控制题目进度</p>
          <p className="text-slate-500 text-sm">Real-time sync · Control question progress</p>
        </div>

        {/* 当前题目 */}
        <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 mb-6">
          <span className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold px-3 py-1 rounded-full">
            当前 Current：第 {data.currentQuestionIndex + 1} / {allQuestions.length} 题 | Q{data.currentQuestionIndex + 1} of {allQuestions.length}
          </span>
          <p className="text-white text-lg mt-4 whitespace-pre-line">{currentQ ? currentQ.question : "所有题目已完成 All questions completed"}</p>
          {currentQ && (
            <p className="text-green-400 text-sm mt-2">正确答案 Correct Answer: {currentQ.correctAnswer}</p>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <button
            onClick={onNextQuestion}
            disabled={isLastQuestion || !currentQ}
            className={`p-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
              isLastQuestion || !currentQ ? "bg-slate-700 text-slate-500 cursor-not-allowed" : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white"
            }`}
          >
            ⏭ {isLastQuestion ? "最后一题 Last" : "下一题 Next"}
          </button>
          <button 
            onClick={() => setShowFinalRanking(!showFinalRanking)} 
            className="p-4 rounded-xl font-bold flex items-center justify-center gap-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30"
          >
            🏆 {showFinalRanking ? "隐藏总榜 Hide" : "最终排行 Final Rank"}
          </button>
          <button onClick={onReset} className="p-4 rounded-xl font-bold flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30">
            🔄 重置 Reset
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
            <p className="text-slate-400 text-sm">本题最快</p>
            <p className="text-slate-500 text-xs">Fastest</p>
            <p className="text-2xl font-bold text-amber-400">
              {currentSubmissions.length > 0 
                ? currentSubmissions.sort((a, b) => a.duration - b.duration)[0]?.userName 
                : "-"}
            </p>
          </div>
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">总用户</p>
            <p className="text-slate-500 text-xs">Total Users</p>
            <p className="text-3xl font-bold text-white">{data.registeredUsers.length}</p>
          </div>
        </div>

        {/* 最终排行榜 */}
        {showFinalRanking && (
          <div className="bg-gradient-to-br from-amber-900/30 to-orange-900/30 rounded-2xl border border-amber-500/30 overflow-hidden mb-8">
            <div className="p-6 border-b border-amber-500/30 bg-amber-500/10">
              <h2 className="text-xl font-bold text-amber-300">🏆 最终排行榜 Final Leaderboard</h2>
              <p className="text-amber-400/70 text-sm">按答对数排序，相同则按总用时排序 | Sorted by correct answers, then by total time</p>
            </div>
            {finalRanking.length === 0 ? (
              <div className="p-12 text-center text-amber-400/50">暂无数据 No data yet</div>
            ) : (
              <div className="divide-y divide-amber-500/20">
                {finalRanking.map((user, index) => (
                  <div key={user.userName} className={`p-4 flex items-center gap-4 ${index < 3 ? "bg-amber-500/10" : ""}`}>
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg ${
                      index === 0 ? "bg-gradient-to-br from-amber-400 to-amber-600 text-white" :
                      index === 1 ? "bg-gradient-to-br from-slate-300 to-slate-400 text-slate-800" :
                      index === 2 ? "bg-gradient-to-br from-orange-400 to-orange-600 text-white" :
                      "bg-slate-700 text-slate-300"
                    }`}>{index + 1}</div>
                    <div className="flex-1">
                      <p className="font-semibold text-white text-lg">{user.userName}</p>
                      <p className="text-amber-400/70 text-sm">
                        已答 {user.submissionCount} 题 | Answered {user.submissionCount} questions
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-green-400 font-bold text-xl">{user.correctCount}/{allQuestions.length}</p>
                      <p className="text-slate-400 text-sm font-mono">{(user.totalTime / 1000).toFixed(1)}s</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 本题提交排名 */}
        <div className="bg-slate-800/50 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="p-6 border-b border-slate-700">
            <h2 className="text-xl font-bold text-white">📋 本题提交详情 Current Question Submissions</h2>
            <p className="text-slate-400 text-sm">按提交时间排序 | Sorted by submission time</p>
          </div>
          {currentSubmissions.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p>等待用户提交...</p>
              <p className="text-sm">Waiting for submissions...</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-700">
              {currentSubmissions.slice(0, 15).map((sub, index) => (
                <div key={sub.id} className={`p-4 flex items-center gap-4 ${index < 3 ? "bg-slate-800/30" : ""}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                    index === 0 ? "bg-gradient-to-br from-amber-400 to-amber-600 text-white" :
                    index === 1 ? "bg-gradient-to-br from-slate-300 to-slate-400 text-slate-800" :
                    index === 2 ? "bg-gradient-to-br from-orange-400 to-orange-600 text-white" :
                    "bg-slate-700 text-slate-300"
                  }`}>{index + 1}</div>
                  <div className="flex-1">
                    <p className="font-semibold text-white">{sub.userName}</p>
                    <p className="text-slate-400 text-sm">
                      选择 {sub.answer} · 用时 {(sub.duration / 1000).toFixed(1)}s
                      {sub.isCorrect ? <span className="text-green-400 ml-2">✓ 正确</span> : <span className="text-red-400 ml-2">✗ 错误</span>}
                    </p>
                  </div>
                  <p className="text-slate-300 font-mono text-sm">{sub.time}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== 渲染应用 ==========
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);

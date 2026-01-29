
import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { db } from "./firebase";
import { ref, onValue, set, update } from "firebase/database";

// ========== 题目数据 ==========
const allQuestions = [
  {
    id: 1,
    question: "以下哪个是 JavaScript 的原始数据类型？",
    options: [
      { id: "A", text: "Array" },
      { id: "B", text: "Object" },
      { id: "C", text: "Symbol" },
      { id: "D", text: "Function" },
    ],
  },
  {
    id: 2,
    question: "React 中，以下哪个 Hook 用于处理副作用？",
    options: [
      { id: "A", text: "useState" },
      { id: "B", text: "useEffect" },
      { id: "C", text: "useContext" },
      { id: "D", text: "useMemo" },
    ],
  },
  {
    id: 3,
    question: "HTTP 状态码 404 表示什么？",
    options: [
      { id: "A", text: "服务器错误" },
      { id: "B", text: "请求成功" },
      { id: "C", text: "资源未找到" },
      { id: "D", text: "重定向" },
    ],
  },
  {
    id: 4,
    question: "CSS 中，哪个属性用于设置弹性布局？",
    options: [
      { id: "A", text: "display: block" },
      { id: "B", text: "display: flex" },
      { id: "C", text: "display: grid" },
      { id: "D", text: "display: inline" },
    ],
  },
];

const initialData = {
  currentQuestionIndex: 0,
  registeredUsers: [],
  submissions: [],
};

// ========== 主应用 ==========
function App() {
  const [page, setPage] = useState("entry");
  const [currentUser, setCurrentUser] = useState("");
  const [data, setData] = useState(initialData);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const dataRef = ref(db, "/");
    const unsubscribe = onValue(dataRef, (snapshot) => {
      const val = snapshot.val();
      if (val) {
        setData({
          currentQuestionIndex: val.currentQuestionIndex || 0,
          registeredUsers: val.registeredUsers || [],
          submissions: val.submissions || [],
        });
      } else {
        set(dataRef, initialData);
      }
      setIsConnected(true);
    });
    return () => unsubscribe();
  }, []);

  const handleRegister = async (userName) => {
    const newUsers = [...(data.registeredUsers || []), userName];
    await update(ref(db, "/"), { registeredUsers: newUsers });
    setCurrentUser(userName);
    setPage("quiz");
  };

  const handleSubmit = async (userName, answer, questionId) => {
    const newSubmission = {
      id: Date.now(),
      userName,
      answer,
      questionId,
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
    if (window.confirm("确定要重置所有数据吗？")) {
      await set(ref(db, "/"), initialData);
      setPage("entry");
      setCurrentUser("");
    }
  };

  // ===== 入口页面 =====
  if (page === "entry") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full">
          <div className="flex justify-center mb-6">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm ${isConnected ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"}`}>
              <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-400" : "bg-yellow-400 animate-pulse"}`}></span>
              {isConnected ? "已连接云端数据库" : "连接中..."}
            </div>
          </div>
          <div className="text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl mb-6 shadow-lg">
              <span className="text-4xl">✨</span>
            </div>
            <h1 className="text-4xl font-bold text-white mb-3">实时答题系统</h1>
            <p className="text-slate-400 text-lg">全球实时同步 · 支持多设备接入</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            <button onClick={() => setPage("register")} className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-indigo-500 rounded-2xl p-8 text-left transition-all">
              <div className="w-14 h-14 bg-indigo-500/20 group-hover:bg-indigo-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">👤</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">参与答题</h2>
              <p className="text-slate-400 mb-6">输入昵称参与互动</p>
              <div className="flex items-center text-indigo-400 font-medium">进入 →</div>
            </button>
            <button onClick={() => setPage("admin")} className="group bg-slate-800/50 hover:bg-slate-800 border border-slate-700 hover:border-purple-500 rounded-2xl p-8 text-left transition-all">
              <div className="w-14 h-14 bg-purple-500/20 group-hover:bg-purple-500 rounded-xl flex items-center justify-center mb-6 transition-all">
                <span className="text-2xl">📊</span>
              </div>
              <h2 className="text-xl font-bold text-white mb-2">管理看板</h2>
              <p className="text-slate-400 mb-6">控制题目与查看排名</p>
              <div className="flex items-center text-purple-400 font-medium">进入 →</div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ===== 注册页面 =====
  if (page === "register") {
    return <RegisterPage data={data} onRegister={handleRegister} onBack={() => setPage("entry")} />;
  }

  // ===== 答题页面 =====
  if (page === "quiz") {
    return <QuizPage currentUser={currentUser} data={data} onSubmit={handleSubmit} onBack={() => setPage("entry")} />;
  }

  // ===== 管理页面 =====
  if (page === "admin") {
    return <AdminPage data={data} onNextQuestion={handleNextQuestion} onReset={handleReset} onBack={() => setPage("entry")} />;
  }

  return null;
}

// ========== 注册页面组件 ==========
function RegisterPage({ data, onRegister, onBack }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError("请输入昵称");
    if (trimmed.length < 2) return setError("昵称至少2个字符");
    if (data.registeredUsers.includes(trimmed)) return setError("昵称已存在，请换一个");
    onRegister(trimmed);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
        <button onClick={onBack} className="text-slate-400 hover:text-white mb-6 flex items-center gap-2">← 返回</button>
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">👤</span>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">输入你的昵称</h2>
          <p className="text-slate-400">昵称将显示在全球排行榜上</p>
        </div>
        <input
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          placeholder="请输入昵称"
          className="w-full bg-slate-900/50 border border-slate-600 focus:border-indigo-500 rounded-xl px-4 py-4 text-white text-center text-lg outline-none mb-4"
          maxLength={10}
        />
        {error && <p className="text-red-400 text-center mb-4 text-sm">{error}</p>}
        {data.registeredUsers.length > 0 && (
          <div className="mb-6 p-4 bg-slate-900/30 rounded-xl">
            <p className="text-slate-500 text-sm mb-2">已有 {data.registeredUsers.length} 人参与</p>
            <div className="flex flex-wrap gap-2">
              {data.registeredUsers.slice(-5).map((n, i) => (
                <span key={i} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded-full">{n}</span>
              ))}
            </div>
          </div>
        )}
        <button onClick={handleSubmit} className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold py-4 rounded-xl transition-all">
          开始答题
        </button>
      </div>
    </div>
  );
}

// ========== 答题页面组件 ==========
function QuizPage({ currentUser, data, onSubmit, onBack }) {
  const [selected, setSelected] = useState(null);
  const currentQ = allQuestions[data.currentQuestionIndex];
  const hasSubmitted = data.submissions.some((s) => s.userName === currentUser && s.questionId === currentQ?.id);

  useEffect(() => { setSelected(null); }, [data.currentQuestionIndex]);

  if (!currentQ) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-6">
        <div className="text-center">
          <div className="text-6xl mb-6">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-2">所有题目已完成</h2>
          <p className="text-slate-400 mb-6">感谢你的参与！</p>
          <button onClick={onBack} className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl">返回首页</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <button onClick={onBack} className="text-slate-400 hover:text-white">← 退出</button>
          <div className="bg-slate-800/50 border border-slate-700 rounded-full px-4 py-2 flex items-center gap-2">
            <span className="text-white font-medium">{currentUser}</span>
          </div>
        </div>

        {hasSubmitted && (
          <div className="mb-6 p-4 bg-indigo-500/10 border border-indigo-500/30 rounded-xl flex items-center gap-3">
            <span className="text-xl">🔒</span>
            <div>
              <p className="text-indigo-300 font-medium">已提交本题答案</p>
              <p className="text-indigo-400/70 text-sm">请等待管理员开启下一题...</p>
            </div>
          </div>
        )}

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
          <div className="flex items-center gap-2 mb-6">
            <span className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold px-3 py-1 rounded-full">
              第 {data.currentQuestionIndex + 1} / {allQuestions.length} 题
            </span>
          </div>
          <h2 className="text-xl font-bold text-white mb-8">{currentQ.question}</h2>
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
              <span>✓</span> 已成功提交答案
            </div>
          ) : (
            <button
              onClick={() => onSubmit(currentUser, selected, currentQ.id)}
              disabled={!selected}
              className={`w-full py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all ${
                selected ? "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white" : "bg-slate-700 text-slate-500 cursor-not-allowed"
              }`}
            >
              提交答案
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== 管理页面组件 ==========
function AdminPage({ data, onNextQuestion, onReset, onBack }) {
  const currentQ = allQuestions[data.currentQuestionIndex];
  const currentSubmissions = data.submissions.filter((s) => s.questionId === currentQ?.id) || [];
  const isLastQuestion = data.currentQuestionIndex >= allQuestions.length - 1;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <button onClick={onBack} className="text-slate-400 hover:text-white">← 返回首页</button>
          <div className="flex items-center gap-2 text-green-400">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
            <span className="text-sm">实时同步中</span>
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">📊 管理看板</h1>
          <p className="text-slate-400">全球实时同步 · 控制题目进度</p>
        </div>

        {/* 当前题目 */}
        <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 mb-6">
          <span className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white text-sm font-bold px-3 py-1 rounded-full">
            当前：第 {data.currentQuestionIndex + 1} / {allQuestions.length} 题
          </span>
          <p className="text-white text-lg mt-4">{currentQ ? currentQ.question : "所有题目已完成"}</p>
        </div>

        {/* 操作按钮 */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <button
            onClick={onNextQuestion}
            disabled={isLastQuestion || !currentQ}
            className={`p-4 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
              isLastQuestion || !currentQ ? "bg-slate-700 text-slate-500 cursor-not-allowed" : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white"
            }`}
          >
            ⏭ {isLastQuestion ? "最后一题" : "下一题"}
          </button>
          <button onClick={onReset} className="p-4 rounded-xl font-bold flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30">
            🔄 重置所有数据
          </button>
        </div>

        {/* 统计 */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">本题已提交</p>
            <p className="text-3xl font-bold text-white">{currentSubmissions.length}</p>
          </div>
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">第一名</p>
            <p className="text-2xl font-bold text-amber-400">{currentSubmissions[0]?.userName || "-"}</p>
          </div>
          <div className="bg-slate-800/50 rounded-2xl p-6 border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">全球用户</p>
            <p className="text-3xl font-bold text-white">{data.registeredUsers.length}</p>
          </div>
        </div>

        {/* 排名列表 */}
        <div className="bg-slate-800/50 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="p-6 border-b border-slate-700">
            <h2 className="text-xl font-bold text-white">🏆 本题提交排名 TOP 10</h2>
          </div>
          {currentSubmissions.length === 0 ? (
            <div className="p-12 text-center text-slate-500">等待用户提交...</div>
          ) : (
            <div className="divide-y divide-slate-700">
              {currentSubmissions.slice(0, 10).map((sub, index) => (
                <div key={sub.id} className={`p-4 flex items-center gap-4 ${index < 3 ? "bg-slate-800/30" : ""}`}>
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${
                    index === 0 ? "bg-gradient-to-br from-amber-400 to-amber-600 text-white" :
                    index === 1 ? "bg-gradient-to-br from-slate-300 to-slate-400 text-slate-800" :
                    index === 2 ? "bg-gradient-to-br from-orange-400 to-orange-600 text-white" :
                    "bg-slate-700 text-slate-300"
                  }`}>{index + 1}</div>
                  <div className="flex-1">
                    <p className="font-semibold text-white">{sub.userName}</p>
                    <p className="text-slate-400 text-sm">选择了选项 {sub.answer}</p>
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

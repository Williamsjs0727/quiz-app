import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  writeBatch
} from 'firebase/firestore';
import { 
  Trophy, 
  AlertCircle, 
  CheckCircle, 
  XCircle, 
  LogOut, 
  Smartphone,
  Square,
  RotateCcw,
  ArrowRight,
  Cpu,
  Globe
} from 'lucide-react';

// --- 0. 配置区域 ---
const firebaseConfig = {
  apiKey: "AIzaSyAaF7DcQS6jNWIj7resv3h_73LX8HbMS5s",
  authDomain: "dynamic-answer-interaction.firebaseapp.com",
  databaseURL: "https://dynamic-answer-interaction-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dynamic-answer-interaction",
  storageBucket: "dynamic-answer-interaction.firebasestorage.app",
  messagingSenderId: "891232819888",
  appId: "1:891232819888:web:0988b3a3db620588eb7975",
  measurementId: "G-ENH3DNG5LE"
};

// 初始化 Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// 默认硬编码题库
const DEFAULT_QUESTIONS = [
  {
    id: 0,
    text: "著名的“图灵测试”是用来测试什么的？",
    options: ["机器的智能程度", "计算机的运算速度", "网络的传输带宽", "硬盘的存储容量"],
    correctAnswer: "A"
  },
  {
    id: 1,
    text: "在HTTP协议中，状态码 404 代表什么？",
    options: ["请求成功", "服务器内部错误", "未找到资源", "禁止访问"],
    correctAnswer: "C"
  },
  {
    id: 2,
    text: "RGB颜色模型中，R、G、B 分别代表什么颜色？",
    options: ["红、绿、黑", "红、绿、蓝", "红、黄、蓝", "红、灰、黑"],
    correctAnswer: "B"
  }
];

// --- 工具函数 ---

// 1. 生成恢复码
const generateRecoveryCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result.match(/.{1,4}/g).join(' '); 
};

// 2. 获取/生成设备ID
const getDeviceId = () => {
  let deviceId = localStorage.getItem('quiz_device_id');
  if (!deviceId) {
    deviceId = 'dev_' + Math.random().toString(36).substr(2, 9) + Date.now();
    localStorage.setItem('quiz_device_id', deviceId);
  }
  return deviceId;
};

// --- 主组件 ---
export default function App() {
  const [user, setUser] = useState(null); 
  const [appState, setAppState] = useState(null); 
  const [authError, setAuthError] = useState(null); 
  
  const [participant, setParticipant] = useState(null); 
  const [deviceMatchUser, setDeviceMatchUser] = useState(null); 
  
  const [view, setView] = useState('loading'); 
  const [inputName, setInputName] = useState('');
  const [inputCode, setInputCode] = useState('');
  
  const [adminPass, setAdminPass] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  
  const [currentSubmission, setCurrentSubmission] = useState(null);
  const [startTime, setStartTime] = useState(null); 

  // 1. 初始化
  useEffect(() => {
    const initAuth = async () => {
        try {
            await signInAnonymously(auth);
        } catch (e) {
            console.error("Auth Failed:", e);
            if (e.code === 'auth/configuration-not-found' || e.code === 'auth/operation-not-allowed') {
                setAuthError({
                    title: "未开启匿名登录",
                    msg: "需要在 Firebase 控制台 Authentication 中开启 'Anonymous' 登录。",
                    link: "https://console.firebase.google.com"
                });
            } else if (e.code === 'auth/unauthorized-domain') {
                setAuthError({
                    title: "域名未授权 (Preview 环境)",
                    msg: `Firebase 默认拦截了此域名。请在 Firebase Console -> Authentication -> Settings -> Authorized domains 中添加：${window.location.hostname}`,
                    link: "https://console.firebase.google.com"
                });
            } else {
                setAuthError({
                    title: "登录失败",
                    msg: e.message,
                    link: null
                });
            }
        }
    };
    initAuth();
    
    const unsubAuth = onAuthStateChanged(auth, (u) => {
        if (u) {
            setUser(u);
            setAuthError(null);
        }
    });

    const unsubSys = onSnapshot(doc(db, 'system', 'config'), (docSnap) => {
      if (docSnap.exists()) {
        setAppState(docSnap.data());
      } else {
        // 初始化系统配置
        setDoc(doc(db, 'system', 'config'), {
          quizStatus: 'running',
          currentQuestionIndex: 0,
          totalQuestions: DEFAULT_QUESTIONS.length
        });
      }
    }, (error) => {
        console.error("System config error:", error);
    });

    return () => {
      unsubAuth();
      unsubSys();
    };
  }, []);

  // 2. 身份识别
  useEffect(() => {
    if (!user) return;
    const localPid = localStorage.getItem('quiz_participant_id');
    const deviceId = getDeviceId();

    if (localPid) {
      const unsub = onSnapshot(doc(db, 'users', localPid), (docSnap) => {
        if (docSnap.exists()) {
          setParticipant({ id: docSnap.id, ...docSnap.data() });
        } else {
          localStorage.removeItem('quiz_participant_id');
          setParticipant(null);
        }
      });
      return () => unsub();
    } else {
      const checkDevice = async () => {
         try {
             const indexRef = doc(db, 'deviceIndex', deviceId);
             const indexSnap = await getDoc(indexRef);
             if (indexSnap.exists()) {
               const pid = indexSnap.data().participantId;
               const userSnap = await getDoc(doc(db, 'users', pid));
               if (userSnap.exists()) {
                 setDeviceMatchUser({ id: pid, ...userSnap.data() });
               }
             }
         } catch (e) { console.error("Device check failed", e); }
      };
      checkDevice();
      setParticipant(null);
    }
  }, [user]);

  // 3. 路由控制
  useEffect(() => {
    if (!appState) return;
    if (view === 'admin') return;

    if (participant) {
      if (appState.quizStatus === 'stopped') {
        setView('result');
      } else if (appState.currentQuestionIndex >= appState.totalQuestions) {
        setView('result');
      } else {
        setView('quiz');
      }
    } else {
      if (deviceMatchUser) {
        setView('entry');
      } else {
        setView('entry');
      }
    }
  }, [participant, appState, deviceMatchUser, view]);

  // 4. 题目监听
  useEffect(() => {
    if (!participant || !appState || view !== 'quiz') return;
    
    const qId = appState.currentQuestionIndex;
    const pid = participant.id;

    const unsubSub = onSnapshot(doc(db, 'submissions', `${pid}_${qId}`), (docSnap) => {
      if (docSnap.exists()) {
        setCurrentSubmission(docSnap.data());
      } else {
        setCurrentSubmission(null);
        if (!showRecoveryModal) {
          ensureStartTime(pid, qId);
        }
      }
    });
    return () => unsubSub();
  }, [participant, appState, view, showRecoveryModal]);

  // 业务逻辑
  const ensureStartTime = async (pid, qId) => {
    const stRef = doc(db, 'startTimes', `${pid}_${qId}`);
    try {
        const snap = await getDoc(stRef);
        if (!snap.exists()) {
          await setDoc(stRef, { time: Date.now() });
          setStartTime(Date.now());
        } else {
          setStartTime(snap.data().time);
        }
    } catch (e) { console.error(e); }
  };

  const handleRegister = async () => {
    if (!inputName.trim()) return;
    setErrorMsg('');
    try {
        const newPid = crypto.randomUUID();
        const code = generateRecoveryCode();
        const deviceId = getDeviceId();
        const userData = {
            userName: inputName.trim(),
            recoveryCode: code,
            createdAt: Date.now(),
            deviceId: deviceId
        };
        const batch = writeBatch(db);
        batch.set(doc(db, 'users', newPid), userData);
        batch.set(doc(db, 'recoveryCodeIndex', code), { participantId: newPid });
        batch.set(doc(db, 'deviceIndex', deviceId), { participantId: newPid });
        await batch.commit();

        setParticipant({ id: newPid, ...userData });
        localStorage.setItem('quiz_participant_id', newPid);
        setShowRecoveryModal(true); 
    } catch (e) {
        setErrorMsg("注册失败");
    }
  };

  const handleRecover = async () => {
    const code = inputCode.trim().toUpperCase();
    if (code.length < 8) return setErrorMsg("恢复码格式不正确");
    const indexSnap = await getDoc(doc(db, 'recoveryCodeIndex', code));
    if (!indexSnap.exists()) return setErrorMsg("恢复码无效");
    const pid = indexSnap.data().participantId;
    const deviceId = getDeviceId();
    await setDoc(doc(db, 'deviceIndex', deviceId), { participantId: pid });
    localStorage.setItem('quiz_participant_id', pid);
  };

  const confirmDeviceEntry = () => {
    if (deviceMatchUser) {
      localStorage.setItem('quiz_participant_id', deviceMatchUser.id);
      setParticipant(deviceMatchUser);
      setDeviceMatchUser(null);
    }
  };

  const submitAnswer = async (optionLabel) => {
    if (!participant || !appState || currentSubmission || appState.quizStatus === 'stopped') return;
    
    const qId = appState.currentQuestionIndex;
    const currentQ = DEFAULT_QUESTIONS[appState.currentQuestionIndex];
    
    const now = Date.now();
    const duration = startTime ? (now - startTime) : 0;
    const isCorrect = optionLabel === currentQ.correctAnswer;

    try {
      await setDoc(doc(db, 'submissions', `${participant.id}_${qId}`), {
        participantId: participant.id,
        userName: participant.userName,
        questionId: qId,
        answer: optionLabel,
        isCorrect: isCorrect,
        startTime: startTime,
        submitTime: now,
        duration: duration
      });
    } catch (e) { alert("提交失败"); }
  };

  const handleLogout = () => {
    if (window.confirm(`确定退出吗？恢复码：${participant.recoveryCode}`)) {
      localStorage.removeItem('quiz_participant_id');
      setParticipant(null);
      setDeviceMatchUser(null);
      setView('entry');
    }
  };

  const adminAction = async (action) => {
    const configRef = doc(db, 'system', 'config');
    const current = appState.currentQuestionIndex;
    
    if (action === 'NEXT' && current < DEFAULT_QUESTIONS.length) {
       await setDoc(configRef, { 
         currentQuestionIndex: current + 1
       }, { merge: true });
    } 
    else if (action === 'STOP') {
       await setDoc(configRef, { quizStatus: 'stopped' }, { merge: true });
    } 
    else if (action === 'RESET') {
       if (window.confirm("确定重置？")) {
         await setDoc(configRef, { 
           quizStatus: 'running', 
           currentQuestionIndex: 0, 
           totalQuestions: DEFAULT_QUESTIONS.length
         });
       }
    }
  };

  // 视图渲染

  // 🚨 错误提示界面
  if (authError) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
            <div className="bg-white p-6 rounded-xl shadow-lg max-w-md text-center space-y-4 border border-red-200">
                <Globe className="w-12 h-12 text-red-500 mx-auto animate-pulse" />
                <div>
                    <h3 className="text-xl font-bold text-red-700">{authError.title}</h3>
                    <p className="text-gray-700 mt-3 text-sm text-left bg-red-50 p-4 rounded-lg border border-red-100">
                        {authError.msg}
                    </p>
                </div>
                {authError.link && (
                    <a 
                        href={authError.link} 
                        target="_blank" 
                        rel="noreferrer"
                        className="block w-full bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 transition"
                    >
                        前往 Firebase 控制台修复
                    </a>
                )}
                <button 
                    onClick={() => window.location.reload()} 
                    className="w-full bg-white text-gray-500 py-3 rounded-xl font-bold border hover:bg-gray-50 transition"
                >
                    已修复，刷新页面
                </button>
            </div>
        </div>
    );
  }

  if (!appState) return <div className="min-h-screen flex items-center justify-center bg-gray-100">Loading System...</div>;

  if (showRecoveryModal && participant) {
    const qId = appState.currentQuestionIndex;
    return (
      <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-yellow-500 mx-auto" />
          <h2 className="text-xl font-bold">请保存恢复码</h2>
          <div className="bg-gray-100 p-4 rounded-lg font-mono text-2xl font-bold tracking-widest break-all select-all border border-dashed border-gray-400">
            {participant.recoveryCode}
          </div>
          <button 
            onClick={() => { setShowRecoveryModal(false); ensureStartTime(participant.id, qId); }}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold"
          >
            我已保存，开始答题
          </button>
        </div>
      </div>
    );
  }

  if (view === 'entry' && deviceMatchUser) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm space-y-6 text-center">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto"><Smartphone className="w-8 h-8 text-blue-600" /></div>
            <div>
                <h2 className="text-xl font-bold">欢迎回来</h2>
                <p className="text-gray-600 mt-2">检测到您可能是 <span className="font-bold">{deviceMatchUser.userName}</span></p>
            </div>
            <div className="space-y-3">
                <button onClick={confirmDeviceEntry} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold">是我，继续</button>
                <button onClick={() => { setDeviceMatchUser(null); setView('entry'); }} className="w-full bg-white text-gray-500 py-3 rounded-xl font-bold border">不是我</button>
            </div>
        </div>
      </div>
    );
  }

  if (view === 'entry' || view === 'register' || view === 'recover') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm space-y-6">
           <h1 className="text-2xl font-bold text-center text-gray-800">实时答题系统</h1>
           {view === 'entry' && (
             <div className="space-y-4">
               <button onClick={() => setView('register')} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold shadow-lg">参与答题</button>
               <button onClick={() => setView('recover')} className="w-full text-blue-600 py-3 font-semibold hover:underline">找回身份</button>
               <div className="pt-4 border-t text-center"><button onClick={() => setView('admin')} className="text-xs text-gray-400">管理员入口</button></div>
             </div>
           )}
           {view === 'register' && (
             <div className="space-y-4">
                <input type="text" placeholder="请输入您的昵称" className="w-full p-3 border rounded-xl" value={inputName} onChange={(e) => setInputName(e.target.value)} />
                {errorMsg && <p className="text-red-500 text-sm">{errorMsg}</p>}
                <button onClick={handleRegister} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold">开始</button>
                <button onClick={() => setView('entry')} className="w-full text-gray-500 py-2">返回</button>
             </div>
           )}
           {view === 'recover' && (
             <div className="space-y-4">
                <input type="text" placeholder="输入 8 位恢复码" className="w-full p-3 border rounded-xl font-mono uppercase" value={inputCode} onChange={(e) => setInputCode(e.target.value)} />
                {errorMsg && <p className="text-red-500 text-sm">{errorMsg}</p>}
                <button onClick={handleRecover} className="w-full bg-green-600 text-white py-3 rounded-xl font-bold">恢复身份</button>
                <button onClick={() => setView('entry')} className="w-full text-gray-500 py-2">返回</button>
             </div>
           )}
        </div>
      </div>
    );
  }

  if (view === 'quiz') {
    const currentQ = DEFAULT_QUESTIONS[appState.currentQuestionIndex];

    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-white shadow p-4 flex justify-between items-center">
            <div className="font-bold text-gray-700">{participant.userName}</div>
            <button onClick={handleLogout} className="text-gray-400"><LogOut className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 p-4 max-w-md mx-auto w-full flex flex-col justify-center space-y-6">
            <div className="flex justify-between items-end">
                <span className="text-sm font-bold px-2 py-1 rounded bg-blue-100 text-blue-600">
                    {`Q${appState.currentQuestionIndex + 1}/${appState.totalQuestions}`}
                </span>
            </div>
            <h2 className="text-2xl font-bold text-gray-800 leading-snug">{currentQ.text}</h2>
            <div className="space-y-3">
                {currentQ.options.map((opt, idx) => {
                    const label = String.fromCharCode(65 + idx);
                    const isSelected = currentSubmission?.answer === label;
                    const isCorrect = currentSubmission?.isCorrect;
                    let btnClass = "w-full p-4 rounded-xl border-2 text-left font-medium transition flex justify-between items-center ";
                    if (currentSubmission) {
                        if (isSelected) btnClass += isCorrect ? "bg-green-50 border-green-500 text-green-700" : "bg-red-50 border-red-500 text-red-700";
                        else btnClass += "bg-gray-50 border-gray-100 text-gray-400";
                    } else {
                        btnClass += "bg-white border-gray-200 hover:border-blue-500";
                    }
                    return (
                        <button key={idx} disabled={!!currentSubmission} onClick={() => submitAnswer(label)} className={btnClass}>
                            <span><span className="font-bold mr-2">{label}.</span> {opt}</span>
                            {currentSubmission && isSelected && (isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />)}
                        </button>
                    );
                })}
            </div>
            
            {currentSubmission && (
                <div className="space-y-4">
                    <div className="text-center p-4 bg-gray-100 rounded-xl">
                        <p>耗时: {(currentSubmission.duration / 1000).toFixed(2)}s · 等待下一题...</p>
                    </div>
                </div>
            )}
        </div>
      </div>
    );
  }

  if (view === 'result') {
    const isStopped = appState.quizStatus === 'stopped';
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col p-4">
        <div className="max-w-md mx-auto w-full flex-1 flex flex-col space-y-6 text-center py-8">
            <div className="w-20 h-20 bg-yellow-500/20 text-yellow-400 rounded-full flex items-center justify-center mx-auto mb-4"><Trophy className="w-10 h-10" /></div>
            <h1 className="text-3xl font-bold">{isStopped ? "问卷已关闭" : "谢谢参与"}</h1>
            <p className="text-gray-400 mt-2">请看大屏幕榜单</p>
            <button onClick={handleLogout} className="w-full border border-gray-700 text-gray-400 py-3 rounded-xl mt-8">退出</button>
        </div>
      </div>
    );
  }

  if (view === 'admin') {
     if (adminPass !== 'admin123') return <div className="min-h-screen flex items-center justify-center bg-gray-100"><input type="password" value={adminPass} onChange={e => setAdminPass(e.target.value)} className="border p-2 rounded" placeholder="Password: admin123" /></div>;
     return <AdminDashboard appState={appState} adminAction={adminAction} />;
  }
  return <div>Unknown State</div>;
}

// --- 管理员看板组件 ---
function AdminDashboard({ appState, adminAction }) {
    return (
        <div className="min-h-screen bg-gray-100 p-6">
            <div className="max-w-4xl mx-auto space-y-6">
                
                <div className="bg-white p-6 rounded-xl shadow-sm space-y-4">
                    <h2 className="font-bold text-gray-800 flex items-center gap-2"><Cpu size={20}/> 基础控制</h2>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 bg-blue-50 p-4 rounded-lg flex justify-between items-center">
                            <div>
                                <span className="text-xs text-blue-500 font-bold uppercase">当前状态</span>
                                <div className="font-bold text-blue-900">
                                    {`预设题库 Q${appState.currentQuestionIndex + 1}`}
                                </div>
                            </div>
                            <div className="text-2xl font-bold text-blue-700 uppercase">{appState.quizStatus}</div>
                        </div>
                        <button onClick={() => adminAction('NEXT')} className="bg-blue-600 text-white p-4 rounded-lg font-bold hover:bg-blue-700">下一题 (Next)</button>
                        <button onClick={() => adminAction('STOP')} className="bg-red-600 text-white p-4 rounded-lg font-bold hover:bg-red-700">结束 (STOP)</button>
                        <button onClick={() => adminAction('RESET')} className="col-span-2 border p-3 rounded-lg text-gray-600 hover:bg-gray-50">重置系统</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
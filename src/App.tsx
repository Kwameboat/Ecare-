import { motion, AnimatePresence } from "motion/react";
import { Send, Image as ImageIcon, Mic, LogOut, HeartPulse, CreditCard, StopCircle, Volume2, ShieldCheck, Search, Plus, Minus, X, Download, Bell, Clock, Zap, ArrowUpRight, ArrowDownLeft, History, PanelLeft, Sparkles } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { auth, db } from "./lib/firebase";
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, User } from "firebase/auth";
import { doc, getDoc, setDoc, onSnapshot, updateDoc, serverTimestamp, arrayUnion, collection, query, where, getDocs, addDoc, orderBy, increment, getDocFromServer, deleteDoc } from "firebase/firestore";
import { generateHealthResponse, generateSpeech, fetchGeminiStatus } from "./lib/gemini";
import ReactMarkdown from "react-markdown";
import { cn } from "./lib/utils";

interface MessageAttachment {
  name: string;
  type: string;
  data: string;
}

interface Message {
  role: 'user' | 'model';
  content: string;
  type?: 'text' | 'voice' | 'image' | 'recommendation' | 'mixed';
  timestamp: any;
  audioUrl?: string;
  attachments?: MessageAttachment[];
  meta?: any; // To store doctor IDs or appointment info in messages
}

interface AvailabilitySlot {
  day: string;
  startTime: string;
  endTime: string;
}

interface Doctor {
  id: string;
  name: string;
  specialty: string;
  email: string;
  bio: string;
  photoUrl: string;
  consultationFee: number;
  durationMinutes: number;
  availability?: AvailabilitySlot[];
  isActive: boolean;
}

interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'reminder' | 'system';
  isRead: boolean;
  createdAt: any;
}

interface CreditPackage {
  id: string;
  credits: number;
  amount: number;
}

interface CreditCosts {
  textPrompt: number;
  imageGen: number;
  voicePrompt: number;
}

interface Transaction {
  id: string;
  userId: string;
  type: 'purchase' | 'usage';
  amount: number;
  cost?: number;
  currency?: string;
  description: string;
  reference?: string;
  createdAt: any;
}

interface AppSettings {
  logoUrl?: string;
  appName?: string;
  tagline?: string;
  paystackKey?: string;
  paystackSecretKey?: string;
  creditPackages?: CreditPackage[];
  creditCosts?: CreditCosts;
}

/** Firestore may return numbers as int/float; admin edits can leave strings — normalize for comparisons. */
function coerceCreditBalance(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }
  return 0;
}

function resolveDeductCost(
  costs: CreditCosts | undefined,
  type: "text" | "voice" | "image" | "recommendation" | "mixed"
): number {
  const base = costs ?? { textPrompt: 1, imageGen: 5, voicePrompt: 2 };
  let raw: unknown = base.textPrompt;
  if (type === "voice") raw = base.voicePrompt;
  if (type === "image" || type === "mixed" || type === "recommendation") raw = base.imageGen;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

interface Appointment {
  id: string;
  userId: string;
  doctorId: string;
  doctorName: string;
  patientName: string;
  dateTime: any;
  endTime: any;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  paymentRef?: string;
  amountPaid?: number;
  meetLink?: string;
  notes?: string;
  reminded?: boolean;
  createdAt: any;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  // Branding doc is read on the login screen; never interrupt the user with a modal.
  if (path === "settings/app" && operationType === OperationType.GET) {
    console.warn("[Firestore] settings/app read failed (using defaults):", JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  if (errInfo.error.toLowerCase().includes('permission')) {
    const isAdminEmail = auth.currentUser?.email?.toLowerCase() === 'brownalice773@gmail.com';
    if (isAdminEmail) {
      alert(`Admin Error: Permission Denied for ${operationType} on ${path}. Check Firestore rules and that your Google account email is verified.`);
    } else if (!auth.currentUser) {
      console.warn(
        `[Firestore] Permission denied while signed out (${operationType} on ${path}). Sign in for full access. Deploy Firestore rules that allow read on settings/app for guests if branding should load before login.`
      );
    } else {
      alert(`Permission denied for ${operationType} on ${path}. Contact support if this persists.`);
    }
  } else if (errInfo.error.toLowerCase().includes('unavailable')) {
    alert(`Connection Error: The backend is currently unreachable. Please check your internet connection or try again in a few minutes.`);
  } else {
    alert(`Firestore Error (${operationType}): ${errInfo.error}`);
  }
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [credits, setCredits] = useState(0);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [sessionId, setSessionId] = useState("main");
  const [sessions, setSessions] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Admin States
  const [searchEmail, setSearchEmail] = useState("");
  const [foundUser, setFoundUser] = useState<any>(null);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [adminTab, setAdminTab] = useState<'users' | 'settings' | 'doctors' | 'appointments'>('users');
  const [paystackKey, setPaystackKey] = useState("");
  const [paystackSecretKey, setPaystackSecretKey] = useState("");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [showTransactions, setShowTransactions] = useState(false);
  const [showCreditPacks, setShowCreditPacks] = useState(false);
  const [autoTopUp, setAutoTopUp] = useState({ enabled: false, threshold: 5, packageId: '1' });
  const [creditPackages, setCreditPackages] = useState<CreditPackage[]>([
    { id: '1', credits: 10, amount: 10 },
    { id: '2', credits: 50, amount: 45 },
    { id: '3', credits: 100, amount: 80 }
  ]);
  const [creditCosts, setCreditCosts] = useState<CreditCosts>({
    textPrompt: 1,
    imageGen: 5,
    voicePrompt: 2
  });

  const [settings, setSettings] = useState<AppSettings>({
    appName: "eCare GH AI",
    tagline: "Your Intelligent Healthcare Companion"
  });
  const [newLogoUrl, setNewLogoUrl] = useState("");

  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [userAppointments, setUserAppointments] = useState<Appointment[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }

    const q = query(
      collection(db, "notifications"),
      where("userId", "==", user.uid)
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const notifs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Notification));
      setNotifications(notifs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "notifications");
    });

    return () => unsubscribe();
  }, [user]);

  const markNotificationRead = async (notifId: string) => {
    try {
      await updateDoc(doc(db, "notifications", notifId), { isRead: true });
    } catch (e) {
      console.error(e);
    }
  };
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [bookingDate, setBookingDate] = useState("");
  const [bookingTime, setBookingTime] = useState("");

  // Doctor Form State
  const [showDoctorForm, setShowDoctorForm] = useState(false);
  const [editingDoctorId, setEditingDoctorId] = useState<string | null>(null);
  const [diagDoctor, setDiagDoctor] = useState<Partial<Doctor>>({ 
    name: "", 
    specialty: "", 
    email: "", 
    bio: "", 
    photoUrl: "", 
    consultationFee: 50,
    durationMinutes: 30,
    availability: [],
    isActive: true 
  });

  // New User Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newCredits, setNewCredits] = useState(24);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'testing' | 'ok' | 'fail'>('testing');
  const [geminiAdminStatus, setGeminiAdminStatus] = useState<
    "idle" | "loading" | "ok" | "missing" | "error"
  >("idle");
  const [geminiKeySource, setGeminiKeySource] = useState<string>("none");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [savingGeminiKey, setSavingGeminiKey] = useState(false);

  const refreshGeminiAdminStatus = useCallback(async () => {
    try {
      setGeminiAdminStatus("loading");
      const s = await fetchGeminiStatus();
      setGeminiKeySource(s.source ?? "none");
      if (!s.ok) {
        setGeminiAdminStatus("error");
        return;
      }
      setGeminiAdminStatus(s.configured ? "ok" : "missing");
    } catch {
      setGeminiAdminStatus("error");
    }
  }, []);

  const saveGeminiKeyToFirestore = async () => {
    const trimmed = geminiKeyDraft.trim();
    if (!trimmed) {
      alert("Paste your Google AI Studio API key first.");
      return;
    }
    setSavingGeminiKey(true);
    try {
      await setDoc(
        doc(db, "settings", "gemini"),
        { apiKey: trimmed, updatedAt: serverTimestamp() },
        { merge: true }
      );
      setGeminiKeyDraft("");
      await refreshGeminiAdminStatus();
      alert("API key saved on the server database. Chat uses it unless GEMINI_API_KEY is also set in Vercel (that wins).");
    } catch (e: unknown) {
      alert(
        "Could not save key: " +
          (e instanceof Error ? e.message : String(e))
      );
    } finally {
      setSavingGeminiKey(false);
    }
  };

  useEffect(() => {
    if (showAdmin && adminTab === "settings") {
      void refreshGeminiAdminStatus();
    }
  }, [showAdmin, adminTab, refreshGeminiAdminStatus]);

  useEffect(() => {
    // Connection health check
    const checkConnection = async () => {
      try {
        await getDocFromServer(doc(db, "settings", "app"));
        setConnectionStatus('ok');
        console.log("Firestore connection healthy.");
      } catch (e: any) {
        console.error("Firestore connection failed:", e);
        setConnectionStatus('fail');
      }
    };
    checkConnection();

    const unsub = onSnapshot(doc(db, "settings", "app"), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as AppSettings;
        setSettings(data);
        setNewLogoUrl(data.logoUrl || "");
        setPaystackKey(data.paystackKey || "");
        if (data.creditPackages) setCreditPackages(data.creditPackages);
        if (data.creditCosts) setCreditCosts(data.creditCosts);

        // Fetch secret key if admin
        if (auth.currentUser?.email?.toLowerCase() === 'brownalice773@gmail.com') {
          getDoc(doc(db, "settings", "paystack")).then(snap => {
            if (snap.exists()) {
              setPaystackSecretKey(snap.data().secretKey || "");
            }
          });
        }

        // Dynamically update favicon and app icon
        if (data.logoUrl) {
          const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement || document.createElement('link');
          link.rel = 'icon';
          link.href = data.logoUrl;
          document.getElementsByTagName('head')[0].appendChild(link);

          const appleLink = document.querySelector("link[rel='apple-touch-icon']") as HTMLLinkElement || document.createElement('link');
          appleLink.rel = 'apple-touch-icon';
          appleLink.href = data.logoUrl;
          document.getElementsByTagName('head')[0].appendChild(appleLink);
        }
      }
    }, (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, "settings/app");
      } catch {
        setConnectionStatus("fail");
      }
    });
    return () => unsub();
  }, []);

  const saveSettings = async () => {
    setIsSavingSettings(true);
    try {
      await setDoc(doc(db, "settings", "app"), {
        ...settings,
        logoUrl: newLogoUrl,
        paystackKey: paystackKey,
        creditPackages: creditPackages,
        creditCosts: creditCosts,
        updatedAt: serverTimestamp()
      }, { merge: true });

      // Save secret key to separate document
      if (auth.currentUser?.email?.toLowerCase() === 'brownalice773@gmail.com') {
        await setDoc(doc(db, "settings", "paystack"), {
          secretKey: paystackSecretKey,
          updatedAt: serverTimestamp()
        }, { merge: true });
      }

      alert("Settings updated successfully!");
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, "settings/app");
    } finally {
      setIsSavingSettings(false);
    }
  };

  const buyCredits = (pkg: CreditPackage) => {
    if (!user) return;
    if (!paystackKey) {
      alert("Payment system is not configured yet. Please contact support.");
      return;
    }

    const handler = (window as any).PaystackPop.setup({
      key: paystackKey,
      email: user.email,
      amount: pkg.amount * 100, // GHS to pesewas
      currency: "GHS",
      metadata: {
        userId: user.uid,
        credits: pkg.credits,
        packageId: pkg.id
      },
      callback: (response: any) => {
        // Verification modal
        const verifyBtn = document.createElement('div');
        verifyBtn.className = "fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center";
        verifyBtn.innerHTML = `
          <div class="bg-slate-900 p-8 rounded-[32px] border border-white/10 flex flex-col items-center gap-4 max-w-sm w-full mx-4 shadow-2xl">
            <div class="w-12 h-12 border-4 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin"></div>
            <p class="text-white font-bold">Verifying Top-up...</p>
          </div>
        `;
        document.body.appendChild(verifyBtn);

        fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference: response.reference })
        })
        .then(res => res.json())
        .then(data => {
          document.body.removeChild(verifyBtn);
          if (data.success) {
            alert(`Top-up successful! Added ${pkg.credits} credits to your account.`);
            setShowCreditPacks(false);
          } else {
            alert("Payment verification failed. Please contact support if you were charged.");
          }
        })
        .catch(err => {
          document.body.removeChild(verifyBtn);
          console.error(err);
          alert("Error verifying payment. Please keep your reference: " + response.reference);
        });
      },
      onClose: () => {
        alert("Transaction cancelled");
      }
    });
    handler.openIframe();
  };

  const updateAutoTopUpSettings = async (enabled: boolean, threshold: number, packageId: string) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, "users", user.uid), {
        autoTopUp: { enabled, threshold, packageId },
        updatedAt: serverTimestamp()
      });
      setAutoTopUp({ enabled, threshold, packageId });
      alert("Auto top-up settings saved!");
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}`);
    }
  };

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  useEffect(() => {
    if (showAdmin && adminTab === 'users') {
      fetchAllUsers();
    }
    if (showAdmin && adminTab === 'doctors') {
      fetchDoctors();
    }
    if (showAdmin && adminTab === 'appointments') {
      fetchAllAppointments();
    }
  }, [showAdmin, adminTab]);

  const fetchDoctors = async () => {
    try {
      const snap = await getDocs(collection(db, "doctors"));
      const doctorsList = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Doctor));
      setDoctors(doctorsList);
      
      // Auto-seed a sample doctor if empty (for demo purposes)
      if (doctorsList.length === 0) {
        const sampleId = "doc_kwame_mensah";
        await setDoc(doc(db, "doctors", sampleId), {
          name: "Dr. Kwame Mensah",
          specialty: "General Physician",
          email: "kwame@ecareghai.com",
          bio: "Specialist in family medicine and diagnostic care with over 15 years of experience in Ghana.",
          isActive: true,
          updatedAt: serverTimestamp()
        });
        fetchDoctors();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchAllAppointments = async () => {
    try {
      const snap = await getDocs(collection(db, "appointments"));
      setAppointments(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment)));
    } catch (e) {
      console.error(e);
    }
  };

  const fetchUserAppointments = async (userId: string) => {
    try {
      const q = query(collection(db, "appointments"), where("userId", "==", userId));
      const snap = await getDocs(q);
      setUserAppointments(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as Appointment)));
    } catch (e) {
      console.error(e);
    }
  };

  const fetchAllUsers = async () => {
    try {
      const snap = await getDocs(collection(db, "users"));
      setAllUsers(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (showAdmin) setSidebarCollapsed(true);
  }, [showAdmin]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const installPWA = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);
        if (u) {
          fetchDoctors();
          const path = `users/${u.uid}`;
          const userDocRef = doc(db, 'users', u.uid);
          
          try {
            const userSnap = await getDoc(userDocRef);
            fetchUserAppointments(u.uid); // Trigger appointment fetch
            if (!userSnap.exists()) {
              await setDoc(userDocRef, {
                email: u.email,
                displayName: u.displayName,
                creditBalance: 24,
                autoTopUp: { enabled: false, threshold: 5, packageId: '' },
                createdAt: serverTimestamp(),
              });
              setCredits(24);
            } else {
              const userData = userSnap.data();
              setCredits(coerceCreditBalance(userData?.creditBalance));
              if (userData?.autoTopUp) setAutoTopUp(userData.autoTopUp);
            }

            // Always listen for balance changes (was missing for newly created profiles).
            onSnapshot(
              userDocRef,
              (snap) => {
                const data = snap.data();
                setCredits(coerceCreditBalance(data?.creditBalance));
                if (data?.autoTopUp) setAutoTopUp(data.autoTopUp);
              },
              (error) => {
                handleFirestoreError(error, OperationType.GET, path);
              }
            );

            // Fetch Transactions
            const transQuery = query(
              collection(db, 'users', u.uid, 'transactions'),
              orderBy('createdAt', 'desc')
            );
            onSnapshot(transQuery, (snap) => {
              setTransactions(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as Transaction[]);
            }, (error) => {
              handleFirestoreError(error, OperationType.GET, `users/${u.uid}/transactions`);
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.GET, path);
          }

          // Load sessions list
          const sessionsQuery = query(collection(db, 'users', u.uid, 'sessions'), where("userId", "==", u.uid));
          onSnapshot(sessionsQuery, (snap) => {
            const sessionList = snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) as any[];
            setSessions(sessionList.sort((a, b) => (b.lastUpdate?.seconds || 0) - (a.lastUpdate?.seconds || 0)));
          }, (error) => {
            handleFirestoreError(error, OperationType.GET, `users/${u.uid}/sessions`);
          });
        } else {
          setDoctors([]);
        }
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user || !sessionId) return;
    
    // Fetch Chat History for the specific session from sub-collection
    const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
    const messagesRef = collection(sessionRef, 'messages');
    const messagesQuery = query(messagesRef, orderBy('timestamp', 'asc'));

    const unsubMessages = onSnapshot(messagesQuery, (snap) => {
      const msgs = snap.docs.map(doc => {
        const data = doc.data();
        return { 
          id: doc.id, 
          ...data,
          timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : (data.timestamp instanceof Date ? data.timestamp : new Date(data.timestamp))
        };
      }) as any[];
      setMessages(msgs);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/sessions/${sessionId}/messages`);
    });

    // Still need to ensure session doc exists for metadata (title, etc)
    const unsubSession = onSnapshot(sessionRef, (docSnap) => {
      if (!docSnap.exists()) {
        setDoc(sessionRef, {
          userId: user.uid,
          title: "New Conversation",
          createdAt: serverTimestamp(),
          lastUpdate: serverTimestamp()
        });
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}/sessions/${sessionId}`);
    });

    return () => {
      unsubMessages();
      unsubSession();
    };
  }, [user, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await signInWithPopup(auth, provider);
    } catch (error: unknown) {
      console.error("Login failed:", error);
      const err = error as { code?: string; message?: string };
      const code = err?.code || "";
      if (code === "auth/unauthorized-domain") {
        alert(
          `Firebase Auth is blocking this domain. In Firebase Console → Authentication → Settings → Authorized domains, add:\n\n${window.location.hostname}\n\nThen try again.`
        );
      } else if (code === "auth/popup-blocked") {
        alert("Your browser blocked the Google sign-in popup. Allow popups for this site and try again.");
      } else if (code === "auth/popup-closed-by-user") {
        return;
      } else if (code === "auth/cancelled-popup-request") {
        return;
      } else {
        alert(err?.message || "Google sign-in failed. Check the browser console and try again.");
      }
    }
  };

  const handleLogout = () => signOut(auth);

  const deductCredits = async (type: 'text' | 'voice' | 'image' | 'recommendation' | 'mixed') => {
    if (!user) return false;
    const mergedCosts = settings.creditCosts ?? creditCosts;
    const cost = resolveDeductCost(mergedCosts, type);

    try {
      const userRef = doc(db, "users", user.uid);
      const balSnap = await getDoc(userRef);
      const liveBalance = balSnap.exists()
        ? coerceCreditBalance(balSnap.data()?.creditBalance)
        : 0;
      setCredits(liveBalance);

      if (liveBalance < cost) {
        alert(
          `Not enough credits! Your account has ${liveBalance}, this action needs ${cost}. Please top up.`
        );
        return false;
      }
    } catch (e) {
      console.error("[Credits] Could not read balance from Firestore:", e);
      if (coerceCreditBalance(credits) < cost) {
        alert("Not enough credits! Please top up.");
        return false;
      }
    }

    const tryClientDeduct = async (): Promise<boolean> => {
      const userRef = doc(db, "users", user.uid);
      await updateDoc(userRef, {
        creditBalance: increment(-cost),
        updatedAt: serverTimestamp(),
      });
      return true;
    };

    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 15_000);
      let resp: Response;
      try {
        resp = await fetch("/api/deduct-credits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.uid, type: type === "mixed" ? "image" : type }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
      }

      const text = await resp.text();
      let data: { success?: boolean; code?: string; error?: string } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }

      if (resp.ok && data?.success) {
        return true;
      }

      const serverSaysUseClient =
        resp.status === 503 &&
        (data?.code === "MISSING_FIREBASE_ADMIN" || data?.code === "DEDUCT_TIMEOUT");
      const gatewayTimeout = resp.status === 504 || resp.status === 502;

      if (serverSaysUseClient) {
        console.warn("[Credits] Server cannot deduct in time or has no Admin SDK — client-side deduction.", data?.code);
      } else if (gatewayTimeout) {
        console.warn("[Credits] Gateway timeout from /api/deduct-credits — client-side deduction.");
      } else if (!resp.ok && data?.error === "Insufficient credits") {
        alert("Not enough credits (verified on server). Please top up.");
        return false;
      }

      await tryClientDeduct();
      return true;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        console.warn("[Credits] Deduct request timed out — trying client-side deduction.");
        try {
          await tryClientDeduct();
          return true;
        } catch (e2: any) {
          alert("Credit deduction failed: " + (e2?.message || String(e2)));
          return false;
        }
      }
      console.error("Deduct error:", e);
      try {
        await tryClientDeduct();
        return true;
      } catch (e2: any) {
        alert("Error processing credits: " + (e2?.message || String(e)));
        return false;
      }
    }
  };

  const playAudio = async (text: string) => {
    initAudio();
    setIsSpeaking(true);
    try {
      const base64Audio = await generateSpeech(text);
      if (base64Audio && audioContextRef.current) {
        const audioContext = audioContextRef.current;
        const binaryString = atob(base64Audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const float32Data = new Float32Array(bytes.length / 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < float32Data.length; i++) {
          const pcm16 = view.getInt16(i * 2, true);
          float32Data[i] = pcm16 / 32768;
        }

        const audioBuffer = audioContext.createBuffer(1, float32Data.length, 24000);
        audioBuffer.getChannelData(0).set(float32Data);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.onended = () => setIsSpeaking(false);
        source.start();
      } else {
        setIsSpeaking(false);
      }
    } catch (e) {
      console.error("Play error:", e);
      setIsSpeaking(false);
    }
  };

  const startNewChat = () => {
    const newSessionId = `chat_${Date.now()}`;
    setSessionId(newSessionId);
    setMessages([]);
    setShowHistory(false);
  };

  const saveMessage = async (msg: Message) => {
    if (!user) return;
    const sessionRef = doc(db, 'users', user.uid, 'sessions', sessionId);
    const messagesRef = collection(sessionRef, 'messages');
    
    try {
      // Add message to sub-collection
      // For images, we skip saving the full base64 to Firestore if it's too large (> 500KB) 
      // but we still send it to Gemini in the active request.
      const msgToSave = { ...msg };
      if (msgToSave.attachments) {
        msgToSave.attachments = msgToSave.attachments.map(att => {
          if (att.data.length > 500000) {
            return { ...att, data: "[Attachment too large to store - but was processed by AI]" };
          }
          return att;
        });
      }

      await addDoc(messagesRef, {
        ...msgToSave,
        timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(),
        serverTimestamp: serverTimestamp()
      });

      // Ensure session metadata exists and update it
      const updates: any = {
        userId: user.uid,
        lastUpdate: serverTimestamp()
      };
      
      if (messages.length === 0 && msg.role === 'user') {
        updates.title = msg.content.substring(0, 40) + (msg.content.length > 40 ? '...' : '');
        updates.createdAt = serverTimestamp();
      }

      await setDoc(sessionRef, updates, { merge: true });
    } catch (e) {
      console.error("Save error:", e);
    }
  };

  const sendMessage = async (type: 'text' | 'voice' | 'image' | 'mixed' = 'text', mediaBase64?: string) => {
    const activeType = attachments.length > 0 ? 'mixed' : type;
    if (!user || (!input.trim() && !mediaBase64 && attachments.length === 0)) return;

    setIsTyping(true);
    try {
      const canProceed = await deductCredits(activeType);
      if (!canProceed) {
        alert("Could not process message. Check your credit balance or try again.");
        return;
      }

      const currentInput = input;
      const userMsg: Message = {
        role: 'user',
        content: currentInput || (activeType === 'image' || activeType === 'mixed' ? "[Attachments]" : "[Voice Message]"),
        type: activeType,
        attachments: attachments.length > 0 ? attachments : (mediaBase64 ? [{ name: 'attachment', type: type === 'image' ? 'image/jpeg' : 'audio/wav', data: mediaBase64 }] : undefined),
        timestamp: new Date()
      };

      setMessages(prev => [...prev, userMsg]);
      saveMessage(userMsg);
      setInput("");
      setAttachments([]);

      try {
      const history = messages.map(m => {
        let parts: any[] = [{ text: m.content }];
        if (m.attachments) {
          m.attachments.forEach(att => {
            if (att.type.startsWith('image/') || att.type === 'application/pdf') {
              parts.push({
                inlineData: {
                  mimeType: att.type,
                  data: att.data.split(',')[1]
                }
              });
            }
          });
        }
        return { role: m.role, parts };
      });

      let mediaParts = [];
      
      // Handle current attachments
      if (userMsg.attachments) {
        userMsg.attachments.forEach(att => {
          if (att.type.startsWith('image/') || att.type === 'application/pdf') {
            mediaParts.push({
              inlineData: {
                mimeType: att.type,
                data: att.data.split(',')[1]
              }
            });
          }
        });
      }

      // Handle direct mediaBase64 (for voice)
      if (mediaBase64 && type === 'voice') {
        mediaParts.push({
          inlineData: {
            mimeType: "audio/wav",
            data: mediaBase64.split(',')[1]
          }
        });
      }

      const responseText = await generateHealthResponse(currentInput, history, mediaParts, doctors);
      
      const aiMsg: Message = {
        role: 'model',
        content: responseText || "I'm sorry, I couldn't process that.",
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiMsg]);
      saveMessage(aiMsg);

      if (type === 'voice' || (responseText && responseText.length < 300)) {
        playAudio(aiMsg.content);
      }
      } catch (error: any) {
        console.error("Gemini Error:", error);
        alert("Error: " + (error.message || "Failed to get a response. Please try again."));
        const errMsg: Message = {
          role: 'model',
          content: `Error: ${error.message || "Failed to get a response. Please try again."}`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errMsg]);
        saveMessage(errMsg);
      }
    } finally {
      setIsTyping(false);
    }
  };

  const startRecording = async () => {
    initAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/wav' });
        const reader = new FileReader();
        reader.onloadend = () => {
          sendMessage('voice', reader.result as string);
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording", err);
      alert("Microphone access denied or not available.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (attachments.length + files.length > 5) {
      alert("Maximum 5 attachments allowed.");
      return;
    }

    files.forEach(file => {
      if (file.size > 2 * 1024 * 1024) {
        alert(`${file.name} is too large. Max 2MB per file.`);
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        setAttachments(prev => [...prev, {
          name: file.name,
          type: file.type,
          data: reader.result as string
        }]);
      };
      reader.readAsDataURL(file);
    });
    // Reset input
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const deleteUser = async (userId: string) => {
    if (!window.confirm("Are you sure you want to delete this user? This cannot be undone.")) return;
    const path = `users/${userId}`;
    try {
      await deleteDoc(doc(db, "users", userId));
      setAllUsers(prev => prev.filter(u => u.id !== userId));
      if (foundUser?.id === userId) setFoundUser(null);
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, path);
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.trim()) return;
    setIsSavingUser(true);
    const dummyId = "manual_" + Math.random().toString(36).substr(2, 9);
    const path = `users/${dummyId}`;

    try {
      await setDoc(doc(db, "users", dummyId), {
        email: newEmail.trim(),
        displayName: newName.trim() || newEmail.trim().split('@')[0],
        creditBalance: newCredits,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isManual: true
      });
      alert("User successfully added!");
      setShowAddForm(false);
      setNewName("");
      setNewEmail("");
      fetchAllUsers();
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, path);
    } finally {
      setIsSavingUser(false);
    }
  };

  // Admin Actions
  const searchUser = async (emailOverride?: string) => {
    const targetEmail = emailOverride || searchEmail;
    if (!targetEmail.trim()) return;
    setIsSearching(true);
    try {
      const q = query(collection(db, "users"), where("email", "==", targetEmail.trim()));
      const snap = await getDocs(q);
      if (!snap.empty) {
        setFoundUser({ id: snap.docs[0].id, ...snap.docs[0].data() });
      } else {
        alert("User not found: " + targetEmail);
        setFoundUser(null);
      }
    } catch (e) {
      console.error(e);
      alert("Search failed. Check permissions.");
    } finally {
      setIsSearching(false);
    }
  };

  const adjustCredits = async (amount: number) => {
    if (!foundUser) return;
    const path = `users/${foundUser.id}`;
    const userRef = doc(db, "users", foundUser.id);
    const newBalance = Math.max(0, (foundUser.creditBalance || 0) + amount);
    try {
      await updateDoc(userRef, {
        creditBalance: newBalance,
        updatedAt: serverTimestamp()
      });
      alert(`Successfully added ${amount} credits!`);
      setFoundUser({ ...foundUser, creditBalance: newBalance });
      fetchAllUsers();
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, path);
    }
  };

  const addDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    const doctorId = editingDoctorId || "doc_" + Math.random().toString(36).substr(2, 9);
    try {
      await setDoc(doc(db, "doctors", doctorId), {
        ...diagDoctor,
        updatedAt: serverTimestamp()
      }, { merge: true });
      
      alert(editingDoctorId ? "Doctor updated successfully!" : "Doctor added successfully!");
      setShowDoctorForm(false);
      setEditingDoctorId(null);
      setDiagDoctor({ 
        name: "", 
        specialty: "", 
        email: "", 
        bio: "", 
        photoUrl: "", 
        consultationFee: 50,
        durationMinutes: 30,
        availability: [],
        isActive: true 
      });
      fetchDoctors();
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `doctors/${doctorId}`);
    }
  };

  const deleteDoctor = async (id: string) => {
    if (!window.confirm("Remove this doctor?")) return;
    try {
      await deleteDoc(doc(db, "doctors", id));
      fetchDoctors();
    } catch (e) {
      console.error(e);
    }
  };

  const updateAppointmentStatus = async (appId: string, status: string, meetLink?: string) => {
    try {
      const updateData: any = { status, updatedAt: serverTimestamp() };
      if (meetLink) updateData.meetLink = meetLink;
      await updateDoc(doc(db, "appointments", appId), updateData);
      fetchAllAppointments();
      alert(`Appointment ${status}!`);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `appointments/${appId}`);
    }
  };

  const bookAppointment = async (paymentRef?: string) => {
    if (!user || !selectedDoctor || !bookingDate || !bookingTime) return;
    const appId = "app_" + Math.random().toString(36).substr(2, 9);
    
    // Calculate end time
    const start = new Date(`${bookingDate}T${bookingTime}:00`);
    const end = new Date(start.getTime() + (selectedDoctor.durationMinutes || 30) * 60000);
    const endTimeStr = end.toISOString().split('.')[0]; // YYYY-MM-DDTHH:mm:ss

    try {
      await setDoc(doc(db, "appointments", appId), {
        userId: user.uid,
        patientName: user.displayName || user.email,
        doctorId: selectedDoctor.id,
        doctorName: selectedDoctor.name,
        dateTime: `${bookingDate}T${bookingTime}:00`,
        endTime: endTimeStr,
        status: 'pending',
        reminded: false,
        paymentRef: paymentRef || null,
        amountPaid: paymentRef ? (selectedDoctor.consultationFee || 0) : 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      alert(paymentRef ? "Payment successful! Appointment booked. Admin will review." : "Appointment requested! Admin will review.");
      setShowBookingModal(false);
      fetchUserAppointments(user.uid);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, `appointments/${appId}`);
    }
  };

  const handleBookingPayment = () => {
    if (!user || !selectedDoctor || !bookingDate || !bookingTime) return;
    
    if ((selectedDoctor.consultationFee || 0) <= 0) {
      bookAppointment();
      return;
    }

    if (!paystackKey) {
      alert("Billing system is being configured. Please contact admin.");
      return;
    }

    const handler = (window as any).PaystackPop.setup({
      key: paystackKey,
      email: user.email,
      amount: (selectedDoctor.consultationFee || 0) * 100, // in pesewas
      currency: "GHS",
      callback: (response: any) => {
        // Verify payment on backend for extra security
        const verifyBtn = document.createElement('div');
        verifyBtn.className = "fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center";
        verifyBtn.innerHTML = `
          <div class="bg-slate-900 p-8 rounded-[32px] border border-white/10 flex flex-col items-center gap-4 max-w-sm w-full mx-4 shadow-2xl">
            <div class="w-12 h-12 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
            <p class="text-white font-bold">Verifying Payment...</p>
          </div>
        `;
        document.body.appendChild(verifyBtn);

        fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference: response.reference })
        })
        .then(res => res.json())
        .then(data => {
          document.body.removeChild(verifyBtn);
          if (data.success) {
            bookAppointment(response.reference);
          } else {
            alert(`Payment verification failed: ${data.error}. If you were charged, please contact support with reference: ${response.reference}`);
          }
        })
        .catch(err => {
          document.body.removeChild(verifyBtn);
          console.error(err);
          // Fallback to booking if server verification fails but user has reference? 
          // Better to be safe and ask them to contact support.
          alert(`Error verifying payment on server. Please contact support with reference: ${response.reference}`);
        });
      },
      onClose: () => {
        alert("Transaction cancelled");
      }
    });
    handler.openIframe();
  };

  const getAvailableSlotsForDate = (doctor: Doctor, dateStr: string) => {
    if (!doctor.availability || !dateStr) return [];
    const date = new Date(dateStr);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[date.getDay()];
    
    const dailyAvailability = doctor.availability.filter(slot => slot.day === dayName);
    if (dailyAvailability.length === 0) return [];
    
    const slots: string[] = [];
    dailyAvailability.forEach(range => {
      let current = new Date(`${dateStr}T${range.startTime}:00`);
      const end = new Date(`${dateStr}T${range.endTime}:00`);
      
      while (current.getTime() + (doctor.durationMinutes || 30) * 60000 <= end.getTime()) {
        slots.push(current.toTimeString().slice(0, 5));
        current = new Date(current.getTime() + (doctor.durationMinutes || 30) * 60000);
      }
    });
    return slots;
  };

  const isAdminUser = user?.email?.toLowerCase() === 'brownalice773@gmail.com';

  if (loading) return <div className="h-screen flex items-center justify-center bg-[#020203]"><HeartPulse className="animate-pulse text-blue-500 w-12 h-12" /></div>;

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#020203] text-white p-6 relative overflow-hidden font-sans">
        <div className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-blue-600/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-purple-600/10 rounded-full blur-[120px]"></div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="z-10 flex flex-col items-center space-y-8 text-center"
        >
          <div className="logo-wrap w-24 h-24 bg-white rounded-[32px] flex items-center justify-center shadow-2xl shadow-blue-500/20 ring-1 ring-white/20 overflow-hidden p-2">
            {settings.logoUrl ? (
              <img 
                src={settings.logoUrl} 
                alt="Logo" 
                className="w-full h-full object-contain" 
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).parentElement?.classList.add('fallback-icon');
                }}
              />
            ) : null}
            <HeartPulse className="logo-fallback-icon text-blue-600 w-14 h-14 hidden" />
            {!settings.logoUrl && <HeartPulse className="text-blue-600 w-14 h-14" />}
          </div>
          <div className="space-y-3">
            <h1 className="text-5xl font-black tracking-tight text-white italic">
              {settings.appName?.split(' ')[0] || "eCare"} <span className="text-blue-500">{settings.appName?.split(' ').slice(1).join(' ') || "GH AI"}</span>
            </h1>
            <p className="text-slate-400 mt-2 max-w-sm font-medium leading-relaxed">
              {settings.tagline || "Your Intelligent Healthcare Companion. eCare GH AI brings advanced medical intelligence to your fingertips."}
            </p>
          </div>
          <button 
            onClick={handleLogin}
            className="group relative bg-white text-black px-10 py-4 rounded-2xl font-bold shadow-[0_0_20px_rgba(255,255,255,0.1)] flex items-center gap-3 hover:bg-slate-100 transition-all active:scale-95"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Connect with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-[#020203] text-slate-100 relative overflow-hidden font-sans">
      <div className="absolute top-[-5%] left-[-20%] w-[80%] h-[40%] bg-blue-600/10 rounded-full blur-[100px] pointer-events-none"></div>
      <div className="absolute bottom-[-5%] right-[-20%] w-[80%] h-[40%] bg-indigo-600/10 rounded-full blur-[100px] pointer-events-none"></div>

      {/* Desktop Sidebar — z-10 so main column + admin overlay stack above for full-screen modals */}
      <aside
        className={cn(
          "hidden lg:flex flex-col shrink-0 border-r border-white/5 bg-[#0d0d0f] z-10 relative transition-[width,min-width] duration-300 ease-out overflow-hidden",
          sidebarCollapsed ? "w-0 min-w-0 max-w-0 border-transparent opacity-0 pointer-events-none" : "w-[320px] opacity-100"
        )}
      >
        <div className="w-[320px] shrink-0 p-8 border-b border-white/5 flex items-center gap-4">
          <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20 ring-1 ring-white/10 overflow-hidden p-1">
            {settings.logoUrl ? (
              <img src={settings.logoUrl} alt="Logo" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
            ) : <HeartPulse className="w-7 h-7 text-blue-600" />}
          </div>
          <div>
            <h1 className="font-black text-xl tracking-tighter text-white uppercase italic leading-tight">
              {settings.appName?.split(' ')[0] || "eCare"} <span className="text-blue-500 italic">{settings.appName?.split(' ').slice(1).join(' ') || "GH AI"}</span>
            </h1>
            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mt-0.5">Health Protocol</p>
          </div>
        </div>

        <div className="p-6">
          <button 
            onClick={startNewChat}
            className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-[20px] flex items-center justify-center gap-3 font-black uppercase text-xs tracking-widest shadow-xl shadow-blue-500/20 transition-all active:scale-95 group"
          >
            <div className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center group-hover:rotate-90 transition-transform">
              <Plus className="w-5 h-5" />
            </div>
            New Consultation
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 space-y-2 custom-scrollbar">
          <div className="px-4 py-2">
            <span className="text-[10px] font-black text-slate-600 uppercase tracking-[0.2em]">Medical Archive</span>
          </div>
          {sessions.length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center text-center p-8">
              <Clock className="w-8 h-8 text-slate-800 mb-2" />
              <p className="text-[10px] font-bold text-slate-700 uppercase tracking-widest">No past consults</p>
            </div>
          ) : (
            sessions.map((sess) => (
              <button
                key={sess.id}
                onClick={() => {
                  setMessages([]);
                  setSessionId(sess.id);
                }}
                className={cn(
                  "w-full p-4 rounded-3xl text-left transition-all border group relative overflow-hidden",
                  sessionId === sess.id 
                    ? "bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20" 
                    : "bg-white/5 border-white/5 hover:border-white/10 hover:bg-white/10"
                )}
              >
                {sessionId === sess.id && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500"></div>}
                <div className="flex items-start justify-between min-w-0">
                  <div className="flex-1 min-w-0 pr-2">
                    <p className={cn(
                      "text-xs font-black truncate uppercase tracking-tight",
                      sessionId === sess.id ? "text-blue-400" : "text-slate-200 group-hover:text-blue-100"
                    )}>
                      {sess.title || "Quick Consult"}
                    </p>
                    <p className="text-[9px] text-slate-600 font-bold mt-1 uppercase">
                      {sess.lastUpdate?.seconds 
                        ? new Date(sess.lastUpdate.seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : "Ready"}
                    </p>
                  </div>
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full mt-1 shrink-0",
                    sessionId === sess.id ? "bg-blue-400 shadow-[0_0_8px_#60a5fa] animate-pulse" : "bg-white/10"
                  )}></div>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="p-8 border-t border-white/5 bg-white/[0.02]">
           <div 
            onClick={() => setShowCreditPacks(true)}
            className="w-full bg-white/5 border border-white/10 p-4 rounded-3xl flex items-center justify-between cursor-pointer hover:bg-white/10 transition-all group shadow-inner"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600/20 rounded-xl flex items-center justify-center text-blue-500 group-hover:scale-110 transition-transform">
                <CreditCard className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-black text-white uppercase">{credits} Credits</p>
                <p className="text-[9px] text-slate-500 font-bold uppercase">Balance</p>
              </div>
            </div>
            <Plus className="w-4 h-4 text-slate-600 group-hover:text-blue-500 transition-colors" />
          </div>
        </div>
      </aside>

      <div className="relative z-30 flex min-w-0 flex-1 flex-col w-full max-w-full lg:max-w-none">
        {/* 360 Experience Polish: Decorative Background Elements */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-500/5 rounded-full blur-[120px] animate-pulse pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/5 rounded-full blur-[120px] animate-pulse pointer-events-none" style={{ animationDelay: '1s' }}></div>
        
        <header className="glass-dark sticky top-0 z-40 flex shrink-0 items-center justify-between gap-2 border-b border-white/5 px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] pb-3 sm:px-4 lg:px-6 lg:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              className="hidden lg:flex p-2.5 sm:p-3 bg-white/10 rounded-2xl text-slate-300 hover:bg-white/15 hover:text-white transition-colors ring-1 ring-white/10 shrink-0"
              aria-label={sidebarCollapsed ? "Expand consultation sidebar" : "Collapse consultation sidebar"}
            >
              <PanelLeft className={cn("w-5 h-5 transition-transform", sidebarCollapsed && "text-blue-400")} />
            </button>
            <button 
              onClick={() => setShowHistory(true)}
              className="lg:hidden p-2.5 sm:p-3 bg-white/5 rounded-2xl text-slate-400 hover:text-white transition-colors shrink-0"
            >
              <Clock className="w-5 h-5" />
            </button>
            <div className="lg:hidden flex items-center gap-3">
              <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center p-1">
                {settings.logoUrl ? (
                  <img src={settings.logoUrl} alt="Logo" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                ) : <HeartPulse className="w-6 h-6 text-blue-600" />}
              </div>
              <h1 className="font-black text-lg tracking-tighter text-white uppercase italic leading-none">
                 {settings.appName?.split(' ')[0] || "eCare"} <span className="text-blue-500 italic">{settings.appName?.split(' ').slice(1).join(' ') || "GH AI"}</span>
              </h1>
            </div>
            <div className="hidden lg:flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-2xl">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
              <span className="text-[10px] uppercase font-black text-emerald-400 tracking-widest">Medical Protocol Active</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            {isAdminUser && (
              <button 
                onClick={() => setShowAdmin(!showAdmin)}
                className={cn(
                  "p-3 rounded-2xl transition-all border shadow-lg",
                  showAdmin ? "bg-blue-500/10 border-blue-500/50 text-blue-400" : "bg-white/5 border-white/10 text-slate-400"
                )}
              >
                <ShieldCheck className="w-5 h-5" />
              </button>
            )}
            <button 
              onClick={() => setShowNotifications(!showNotifications)}
              className="p-3 bg-white/5 border border-white/10 text-slate-400 rounded-2xl relative hover:bg-white/10 transition-all shadow-lg"
            >
              <Bell className="w-5 h-5" />
              {notifications.filter(n => !n.isRead).length > 0 && (
                <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full ring-2 ring-[#0d0d0f]"></span>
              )}
            </button>
            <div className="lg:hidden flex items-center">
               <div 
                onClick={() => setShowCreditPacks(true)}
                className="bg-white/5 border border-white/10 px-3 py-2.5 rounded-2xl flex items-center gap-2 cursor-pointer hover:bg-white/10 transition-colors group"
              >
                <span className="text-sm font-black text-white">{credits}</span>
                <CreditCard className="w-4 h-4 text-blue-500" />
              </div>
            </div>
            <button 
              onClick={() => setShowTransactions(true)}
              className="p-3 bg-white/5 border border-white/10 text-slate-400 rounded-2xl hover:text-white transition-all shadow-lg"
            >
              <History className="w-5 h-5" />
            </button>
            <div className="hidden md:flex items-center gap-3 pl-2 ml-2 border-l border-white/5">
              <div className="text-right">
                <p className="text-[10px] font-black text-white uppercase leading-none mb-1">{user.displayName?.split(' ')[0]}</p>
                <p className="text-[8px] font-bold text-slate-500 uppercase tracking-tighter">Verified User</p>
              </div>
              <button onClick={handleLogout} className="p-3 bg-red-500/5 border border-red-500/10 text-red-500 rounded-2xl hover:bg-red-500/10 transition-all shadow-lg active:scale-95">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 flex flex-col max-w-4xl w-full mx-auto relative overflow-hidden">
          {/* Historical Overlay for Mobile */}
          <AnimatePresence>
            {showHistory && (
              <motion.div 
                initial={{ opacity: 0, x: -100 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -100 }}
                className="fixed inset-y-0 left-0 z-[60] w-full max-w-[320px] bg-[#0d0d0f] border-r border-white/5 shadow-2xl flex flex-col lg:hidden"
              >
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-black text-white uppercase tracking-widest">Chat History</h3>
                <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">Revisit your health journey</p>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            
            <div className="p-4">
              <button 
                onClick={startNewChat}
                className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl flex items-center justify-center gap-3 font-black uppercase text-xs tracking-widest shadow-xl shadow-blue-500/10 transition-all active:scale-95"
              >
                <Plus className="w-5 h-5" />
                Start New Consultation
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {sessions.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8">
                  <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4">
                    <Clock className="w-8 h-8 text-slate-700" />
                  </div>
                  <p className="text-xs font-bold text-slate-600 uppercase tracking-widest leading-relaxed">No chat history available</p>
                </div>
              ) : (
                sessions.map((sess) => (
                  <button
                    key={sess.id}
                    onClick={() => {
                      setMessages([]);
                      setSessionId(sess.id);
                      setShowHistory(false);
                    }}
                    className={cn(
                      "w-full p-4 rounded-2xl text-left transition-all border group",
                      sessionId === sess.id 
                        ? "bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20" 
                        : "bg-white/5 border-white/5 hover:border-white/10 hover:bg-white/10"
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-xs font-black truncate uppercase tracking-tight",
                          sessionId === sess.id ? "text-blue-400" : "text-white group-hover:text-blue-200"
                        )}>
                          {sess.title || "Untitled Session"}
                        </p>
                        <p className="text-[9px] text-slate-500 font-bold mt-1 uppercase">
                          {sess.lastUpdate?.seconds 
                            ? new Date(sess.lastUpdate.seconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                            : "New Chat"}
                        </p>
                      </div>
                      <div className={cn(
                        "w-1.5 h-1.5 rounded-full mt-1 shrink-0",
                        sessionId === sess.id ? "bg-blue-400 shadow-[0_0_8px_#60a5fa]" : "bg-white/10"
                      )}></div>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="p-6 border-t border-white/5 bg-white/5">
              <div className="flex items-center gap-3 text-slate-500">
                {settings.logoUrl ? (
                  <img src={settings.logoUrl} className="w-4 h-4 object-contain filter grayscale opacity-50" referrerPolicy="no-referrer" />
                ) : (
                  <HeartPulse className="w-4 h-4" />
                )}
                <p className="text-[10px] font-black uppercase tracking-tighter">Your Diagnostic Assistant</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showCreditPacks && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#0d0d0f] border border-white/5 rounded-[40px] w-full max-w-lg overflow-hidden shadow-2xl"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-black text-white uppercase tracking-tight italic">Top Up <span className="text-blue-500">Credits</span></h3>
                  <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">Get more credits for AI analysis</p>
                </div>
                <button onClick={() => setShowCreditPacks(false)} className="p-3 bg-white/5 rounded-2xl hover:bg-white/10 transition-colors">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
                {/* Auto Top-up Section */}
                <div className="bg-blue-600/10 border border-blue-500/20 rounded-3xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-blue-500/20 rounded-xl flex items-center justify-center shadow-inner">
                        <Zap className="w-5 h-5 text-blue-400" />
                      </div>
                      <div>
                        <p className="text-sm font-black text-white uppercase tracking-tight">Auto Top-Up</p>
                        <p className="text-[9px] text-blue-300/60 font-bold uppercase">Never run out of credits</p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={autoTopUp.enabled}
                        onChange={(e) => updateAutoTopUpSettings(e.target.checked, autoTopUp.threshold, autoTopUp.packageId)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                  
                  {autoTopUp.enabled && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4 pt-2 border-t border-blue-500/10">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-[8px] font-black text-blue-300/50 uppercase tracking-widest pl-1">Threshold</label>
                          <select 
                            value={autoTopUp.threshold}
                            onChange={(e) => updateAutoTopUpSettings(autoTopUp.enabled, parseInt(e.target.value), autoTopUp.packageId)}
                            className="w-full bg-black/20 border border-blue-500/20 rounded-xl px-4 py-2 text-xs text-white"
                          >
                            <option value="5" className="bg-slate-900">Below 5 credits</option>
                            <option value="10" className="bg-slate-900">Below 10 credits</option>
                            <option value="20" className="bg-slate-900">Below 20 credits</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[8px] font-black text-blue-300/50 uppercase tracking-widest pl-1">Package</label>
                          <select 
                            value={autoTopUp.packageId}
                            onChange={(e) => updateAutoTopUpSettings(autoTopUp.enabled, autoTopUp.threshold, e.target.value)}
                            className="w-full bg-black/20 border border-blue-500/20 rounded-xl px-4 py-2 text-xs text-white"
                          >
                            {creditPackages.map(pkg => (
                              <option key={pkg.id} value={pkg.id} className="bg-slate-900">{pkg.credits} Credits</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <p className="text-[9px] text-blue-300/40 leading-relaxed">
                        Automatic top-ups will be charged using your last used payment method. Ensure your card is authorized for recurring charges.
                      </p>
                    </motion.div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4">
                  {creditPackages.map((pkg) => (
                    <button 
                      key={pkg.id}
                      onClick={() => buyCredits(pkg)}
                      className="group relative p-6 bg-white/5 border border-white/5 rounded-3xl flex items-center justify-between hover:bg-white/10 hover:border-white/10 transition-all text-left overflow-hidden active:scale-[0.98]"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-blue-500/0 via-blue-500/0 to-blue-500/0 group-hover:from-blue-500/5 transition-all"></div>
                      <div className="flex items-center gap-4 relative z-10">
                        <div className="w-12 h-12 bg-blue-500/10 rounded-2xl flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                          <CreditCard className="w-6 h-6" />
                        </div>
                        <div>
                          <p className="text-lg font-black text-white">{pkg.credits} Credits</p>
                          <p className="text-[10px] text-slate-500 font-bold uppercase">Best for small usage</p>
                        </div>
                      </div>
                      <div className="text-right relative z-10">
                        <p className="text-xl font-black text-blue-400">GHS {pkg.amount}</p>
                        <p className="text-[9px] text-slate-600 font-black uppercase tracking-tighter group-hover:text-blue-500/60 transition-colors">Instant Top Up</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="p-6 bg-white/5 border-t border-white/5 text-center">
                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest leading-relaxed">
                  Currency: Ghana Cedis (GHS) • Managed by Paystack
                </p>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTransactions && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#0f1115] border border-white/10 rounded-[40px] w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-black text-white uppercase tracking-tight italic">Transaction <span className="text-blue-500">History</span></h3>
                  <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">Full 360 overview of your usage</p>
                </div>
                <button onClick={() => setShowTransactions(false)} className="p-3 bg-white/5 rounded-2xl hover:bg-white/10 transition-colors">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 min-h-[400px] max-h-[60vh]">
                {transactions.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8">
                    <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mb-6">
                      <Clock className="w-10 h-10 text-slate-800" />
                    </div>
                    <p className="text-xs font-black text-slate-600 uppercase tracking-widest">No activities recorded yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {transactions.map((t) => (
                      <div key={t.id} className="bg-white/5 border border-white/5 p-4 rounded-3xl flex items-center justify-between hover:bg-white/[0.07] transition-all group">
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-10 h-10 rounded-xl flex items-center justify-center",
                            t.type === 'purchase' ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                          )}>
                            {t.type === 'purchase' ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownLeft className="w-5 h-5" />}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-white group-hover:text-blue-200 transition-colors">{t.description}</p>
                            <p className="text-[9px] text-slate-500 font-bold uppercase mt-1">
                              {t.createdAt?.seconds ? new Date(t.createdAt.seconds * 1000).toLocaleString() : "Processing..."}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={cn(
                            "text-base font-black italic",
                            t.amount > 0 ? "text-emerald-400" : "text-slate-400"
                          )}>
                            {t.amount > 0 ? '+' : ''}{t.amount} Credits
                          </p>
                          {t.cost && (
                            <p className="text-[10px] text-slate-600 font-black uppercase">{t.currency} {t.cost}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              <div className="p-8 border-t border-white/5 flex items-center justify-between bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                    <CreditCard className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <p className="text-xs font-black text-white uppercase tracking-tight">Available Balance</p>
                    <p className="text-[9px] text-slate-500 font-black uppercase">{credits} Credits</p>
                  </div>
                </div>
                <button 
                  onClick={() => { setShowTransactions(false); setShowCreditPacks(true); }}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest transition-all shadow-lg shadow-blue-500/20 active:scale-95"
                >
                  Buy More
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showNotifications && (
          <motion.div 
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 100 }}
            className="fixed inset-y-0 right-0 z-[60] w-full max-w-[320px] bg-[#0d0d0f] border-l border-white/5 shadow-2xl flex flex-col"
          >
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-sm font-black text-white uppercase tracking-widest">Notifications</h3>
              <button onClick={() => setShowNotifications(false)} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {notifications.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8">
                  <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4">
                    <Bell className="w-8 h-8 text-slate-700" />
                  </div>
                  <p className="text-xs font-bold text-slate-600 uppercase tracking-widest">No notifications yet</p>
                </div>
              ) : (
                notifications.map(notif => (
                  <div 
                    key={notif.id} 
                    className={cn(
                      "p-4 rounded-2xl transition-all border cursor-pointer",
                      notif.isRead 
                        ? "bg-white/[0.02] border-white/5 opacity-60" 
                        : "bg-blue-500/5 border-blue-500/20"
                    )}
                    onClick={() => markNotificationRead(notif.id)}
                  >
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-[10px] font-black text-blue-400 uppercase tracking-widest">{notif.type}</span>
                      <span className="text-[8px] font-bold text-slate-600">{new Date(notif.createdAt?.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-xs font-black text-white mb-1">{notif.title}</p>
                    <p className="text-[10px] text-slate-400 font-medium leading-relaxed">{notif.message}</p>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Admin Panel Overlay */}
      <AnimatePresence>
        {showAdmin && (
          <motion.div 
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed inset-0 z-[200] bg-[#020203] flex flex-col p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] sm:p-6 overflow-hidden"
          >
            <div className="flex justify-between items-center mb-8 shrink-0">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20">
                  <ShieldCheck className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h2 className="text-2xl font-black italic tracking-tight uppercase">eCare <span className="text-blue-500">Admins</span></h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse", connectionStatus === 'ok' ? 'bg-emerald-400' : connectionStatus === 'fail' ? 'bg-red-500' : 'bg-yellow-400')}></div>
                    <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">
                      {connectionStatus === 'ok' ? 'Database Connected' : connectionStatus === 'fail' ? 'Connection Error' : 'Testing Link...'}
                    </span>
                  </div>
                </div>
              </div>
              <button onClick={() => setShowAdmin(false)} className="p-2 bg-white/5 rounded-full hover:bg-white/10 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex gap-2 mb-8 shrink-0 overflow-x-auto pb-2 no-scrollbar">
              <button 
                onClick={() => setAdminTab('users')}
                className={cn(
                  "px-6 py-2.5 rounded-2xl font-bold text-sm transition-all whitespace-nowrap",
                  adminTab === 'users' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-white/5 text-slate-400 hover:bg-white/10"
                )}
              >
                Users & Subscribers
              </button>
              <button 
                onClick={() => setAdminTab('settings')}
                className={cn(
                  "px-6 py-2.5 rounded-2xl font-bold text-sm transition-all whitespace-nowrap",
                  adminTab === 'settings' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-white/5 text-slate-400 hover:bg-white/10"
                )}
              >
                API Settings
              </button>
              <button 
                onClick={() => setAdminTab('doctors')}
                className={cn(
                  "px-6 py-2.5 rounded-2xl font-bold text-sm transition-all whitespace-nowrap",
                  adminTab === 'doctors' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-white/5 text-slate-400 hover:bg-white/10"
                )}
              >
                Doctors
              </button>
              <button 
                onClick={() => setAdminTab('appointments')}
                className={cn(
                  "px-6 py-2.5 rounded-2xl font-bold text-sm transition-all whitespace-nowrap",
                  adminTab === 'appointments' ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-white/5 text-slate-400 hover:bg-white/10"
                )}
              >
                Bookings
              </button>
              <button 
                onClick={() => setShowAddForm(!showAddForm)}
                className={cn(
                  "px-6 py-2.5 rounded-2xl font-bold text-sm transition-all flex items-center gap-2",
                  showAddForm ? "bg-red-500/10 text-red-400 border border-red-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                )}
              >
                {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {showAddForm ? "Cancel" : "Add User"}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 space-y-6 custom-scrollbar pb-10">
              {adminTab === 'users' ? (
                <>
                  {showAddForm && (
                    <motion.form 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      onSubmit={handleAddUser}
                      className="glass p-6 rounded-[32px] border-emerald-500/30 bg-emerald-500/5 space-y-4 shadow-xl"
                    >
                      <h3 className="font-bold text-emerald-400 flex items-center gap-2">
                        <Plus className="w-4 h-4" /> New Subscriber
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Email Address</label>
                          <input 
                            required
                            type="email"
                            value={newEmail}
                            onChange={(e) => setNewEmail(e.target.value)}
                            placeholder="user@example.com"
                            className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm outline-none focus:border-emerald-500/50"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Display Name</label>
                          <input 
                            type="text"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="John Doe"
                            className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm outline-none focus:border-emerald-500/50"
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="flex-1 space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Initial Credits</label>
                          <input 
                            type="number"
                            value={newCredits}
                            onChange={(e) => setNewCredits(parseInt(e.target.value))}
                            className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm outline-none focus:border-emerald-500/50"
                          />
                        </div>
                        <button 
                          disabled={isSavingUser}
                          className="self-end bg-emerald-500 text-white font-bold px-8 py-3 rounded-2xl active:scale-95 transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                        >
                          {isSavingUser ? "Adding..." : "Confirm Add"}
                        </button>
                      </div>
                    </motion.form>
                  )}

                  <div className="space-y-4">
                    <div className="flex gap-2">
                      <div className="flex-1 bg-white/5 border border-white/10 rounded-2xl flex items-center px-4">
                        <Search className="w-4 h-4 text-slate-500 mr-3" />
                        <input 
                          value={searchEmail}
                          onChange={(e) => setSearchEmail(e.target.value)}
                          placeholder="Quick find by email..."
                          className="bg-transparent border-none outline-none text-sm w-full py-4"
                        />
                      </div>
                      <button 
                        onClick={() => searchUser()}
                        disabled={isSearching}
                        className="bg-white text-black px-8 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                      >
                        {isSearching ? "..." : "Find"}
                      </button>
                    </div>

                    {foundUser && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="glass p-6 rounded-[32px] border-blue-500/30 bg-blue-500/5 space-y-6 shadow-xl"
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-xl">{foundUser.displayName}</p>
                              {foundUser.isManual && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-black uppercase">Manual</span>}
                            </div>
                            <p className="text-sm text-slate-500 font-medium">{foundUser.email}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-3xl font-black text-blue-400">{foundUser.creditBalance}</p>
                            <p className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Balance</p>
                          </div>
                        </div>
                        
                        <div className="grid grid-cols-3 gap-3">
                          <button onClick={() => adjustCredits(-20)} className="bg-white/5 py-4 rounded-2xl flex flex-col items-center justify-center border border-white/10 hover:bg-red-500/10 transition-colors group">
                            <Minus className="w-5 h-5 mb-1 group-active:scale-90 transition-transform" />
                            <span className="text-xs font-bold text-slate-400">-20</span>
                          </button>
                          <button onClick={() => adjustCredits(20)} className="bg-blue-600 py-4 rounded-2xl flex flex-col items-center justify-center shadow-lg shadow-blue-500/20 active:scale-95 transition-all text-white">
                            <Plus className="w-5 h-5 mb-1" />
                            <span className="text-xs font-bold">+20</span>
                          </button>
                          <button onClick={() => adjustCredits(100)} className="bg-white text-black py-4 rounded-2xl flex flex-col items-center justify-center font-black active:scale-95 transition-all">
                            <span className="text-lg">+100</span>
                            <span className="text-[10px] uppercase opacity-50">Boost</span>
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em] px-2">Subscribers Database</h3>
                    <div className="glass rounded-[32px] overflow-hidden border-white/5">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="bg-white/5 border-b border-white/5">
                            <tr>
                              <th className="px-6 py-4 font-bold text-slate-400">User</th>
                              <th className="px-6 py-4 font-bold text-slate-400 text-center">Credits</th>
                              <th className="px-6 py-4 font-bold text-slate-400 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                            {allUsers.length === 0 ? (
                              <tr>
                                <td colSpan={3} className="px-6 py-10 text-center text-slate-600 italic">No users found in database</td>
                              </tr>
                            ) : (
                              allUsers.map((u) => (
                                <tr key={u.id} className="hover:bg-white/5 transition-colors group">
                                  <td className="px-6 py-4">
                                    <p className="font-bold text-white group-hover:text-blue-400 transition-colors truncate max-w-[120px]">{u.displayName}</p>
                                    <p className="text-[10px] text-slate-500 truncate max-w-[120px]">{u.email}</p>
                                  </td>
                                  <td className="px-6 py-4 text-center">
                                    <span className="bg-blue-500/10 text-blue-400 px-3 py-1 rounded-lg font-black text-xs">
                                      {u.creditBalance}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-right">
                                    <div className="flex justify-end gap-2">
                                      <button 
                                        onClick={() => { setSearchEmail(u.email); searchUser(u.email); }}
                                        className="flex items-center gap-2 px-3 py-2 bg-blue-500/10 rounded-xl hover:bg-blue-500/20 text-blue-400 transition-all border border-blue-500/20"
                                      >
                                        <CreditCard className="w-4 h-4" />
                                        <span className="text-[10px] font-bold uppercase">Manage</span>
                                      </button>
                                      <button 
                                        onClick={() => deleteUser(u.id)}
                                        className="p-2 bg-red-500/10 rounded-xl hover:bg-red-500/20 text-red-400 transition-all border border-red-500/20"
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </>
              ) : adminTab === 'settings' ? (
                <div className="space-y-8 p-2 overflow-y-auto max-h-[70vh]">
                  {/* Branding Settings */}
                  <div className="glass p-8 rounded-[32px] border-white/5 space-y-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center">
                        <HeartPulse className="w-6 h-6 text-blue-500" />
                      </div>
                      <div>
                        <h4 className="font-bold text-lg">Branding & Logo</h4>
                        <p className="text-xs text-slate-500 mt-1">Customize the interface identity</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest pl-1">App Logo (Icon)</label>
                        <div className="flex gap-4 items-start">
                          <label className="flex-1 cursor-pointer">
                            <div className="w-full bg-white/5 border-2 border-dashed border-white/10 hover:border-blue-500/30 rounded-[24px] p-6 transition-all flex flex-col items-center justify-center gap-3 group">
                              <div className="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center group-hover:bg-blue-500/20 transition-colors">
                                <Plus className="w-5 h-5 text-blue-500" />
                              </div>
                              <div className="text-center">
                                <span className="text-sm font-bold text-slate-300 block">Click to upload logo</span>
                                <span className="text-[10px] text-slate-500 uppercase tracking-tighter">PNG, SVG or JPG (Max 500KB)</span>
                              </div>
                              <input 
                                type="file" 
                                className="hidden" 
                                accept="image/*"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    if (file.size > 500000) {
                                      alert("File too large. Max 500KB for cloud sync.");
                                      return;
                                    }
                                    const reader = new FileReader();
                                    reader.onloadend = () => {
                                      setNewLogoUrl(reader.result as string);
                                    };
                                    reader.readAsDataURL(file);
                                  }
                                }}
                              />
                            </div>
                          </label>
                          {newLogoUrl && (
                            <div className="w-24 h-24 bg-white rounded-[24px] border border-blue-500/20 flex flex-col items-center justify-center p-2 relative shadow-2xl shadow-blue-500/10 shrink-0">
                              <img src={newLogoUrl} alt="Logo Preview" className="w-full h-full object-contain" />
                              <button 
                                onClick={() => setNewLogoUrl("")}
                                className="absolute -top-2 -right-2 bg-red-500 text-white p-1.5 rounded-full hover:bg-red-600 shadow-lg active:scale-95 transition-all"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest pl-1">App Name</label>
                        <input 
                          type="text"
                          value={settings.appName}
                          onChange={(e) => setSettings({...settings, appName: e.target.value})}
                          placeholder="eCare GH AI"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm outline-none focus:border-blue-500/50 transition-colors text-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest pl-1">Tagline</label>
                        <input 
                          type="text"
                          value={settings.tagline}
                          onChange={(e) => setSettings({...settings, tagline: e.target.value})}
                          placeholder="Your Intelligent Healthcare Companion"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm outline-none focus:border-blue-500/50 transition-colors text-white"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Google Gemini — server-side API (key in Vercel / .env.local, not in browser) */}
                  <div className="glass p-8 rounded-[32px] border-blue-500/15 space-y-6 bg-blue-500/[0.03]">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="w-12 h-12 bg-blue-500/15 rounded-2xl flex items-center justify-center shrink-0">
                          <Sparkles className="w-6 h-6 text-blue-400" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-bold text-lg text-white">Google Gemini API</h4>
                          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                            Chat and voice run on the server so your key stays private. Prefer{" "}
                            <code className="text-emerald-400/90">GEMINI_API_KEY</code> on Vercel, or save a key here (stored in Firestore; env wins if both exist).
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {geminiAdminStatus === "loading" && (
                          <span className="text-[10px] font-black uppercase text-slate-500">Checking…</span>
                        )}
                        {geminiAdminStatus === "ok" && (
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-black uppercase border border-emerald-500/25">
                              Connected
                            </span>
                            <span className="text-[10px] font-bold uppercase text-slate-500">
                              {geminiKeySource === "environment"
                                ? "Source: Vercel env"
                                : geminiKeySource === "firestore"
                                  ? "Source: database"
                                  : ""}
                            </span>
                          </span>
                        )}
                        {geminiAdminStatus === "missing" && (
                          <span className="px-3 py-1.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-black uppercase border border-amber-500/25">
                            Key missing on server
                          </span>
                        )}
                        {geminiAdminStatus === "idle" && (
                          <span className="text-[10px] font-black uppercase text-slate-600">—</span>
                        )}
                        {geminiAdminStatus === "error" && (
                          <span className="px-3 py-1.5 rounded-full bg-red-500/15 text-red-400 text-[10px] font-black uppercase border border-red-500/25">
                            Status check failed
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => void refreshGeminiAdminStatus()}
                          className="px-4 py-2 rounded-xl bg-white/10 text-[10px] font-black uppercase tracking-wider hover:bg-white/15 transition-colors border border-white/10"
                        >
                          Refresh
                        </button>
                      </div>
                    </div>
                    <div className="rounded-2xl bg-black/30 border border-white/10 p-5 space-y-4 text-xs text-slate-400 leading-relaxed">
                      <div className="space-y-2">
                        <p className="font-bold text-slate-300 text-sm">Save key on server (optional)</p>
                        <p className="text-[11px] text-slate-500">
                          Paste your Google AI Studio key and save. Only admins can write; the key is not readable from the client app.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="password"
                            autoComplete="off"
                            placeholder="AIza…"
                            value={geminiKeyDraft}
                            onChange={(e) => setGeminiKeyDraft(e.target.value)}
                            className="flex-1 px-4 py-2.5 rounded-xl bg-black/40 border border-white/10 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                          />
                          <button
                            type="button"
                            disabled={savingGeminiKey}
                            onClick={() => void saveGeminiKeyToFirestore()}
                            className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[10px] font-black uppercase tracking-wider text-white shrink-0"
                          >
                            {savingGeminiKey ? "Saving…" : "Save to database"}
                          </button>
                        </div>
                      </div>
                      <p className="font-bold text-slate-300 text-sm pt-1 border-t border-white/5">Or use Vercel</p>
                      <ol className="list-decimal pl-5 space-y-2 marker:text-blue-500">
                        <li>
                          Create a key in{" "}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 underline font-semibold hover:text-blue-300"
                          >
                            Google AI Studio
                          </a>
                          .
                        </li>
                        <li>
                          Vercel → Project → Settings → Environment Variables → add{" "}
                          <code className="text-emerald-400">GEMINI_API_KEY</code> for Production (and Preview if you use preview deploys).
                        </li>
                        <li>Redeploy, then tap Refresh above.</li>
                      </ol>
                      <p className="text-[10px] text-slate-500 border-t border-white/5 mt-3 pt-3">
                        Local: add <code className="text-slate-300">GEMINI_API_KEY</code> to{" "}
                        <code className="text-slate-300">.env.local</code> and run{" "}
                        <code className="text-slate-300">npm run dev</code>.
                      </p>
                    </div>
                  </div>

                  {/* Credit Management System */}
                    <div className="glass p-8 rounded-[32px] border-white/5 space-y-8">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-blue-600/20 rounded-2xl flex items-center justify-center">
                                <CreditCard className="w-6 h-6 text-blue-500" />
                            </div>
                            <div>
                                <h4 className="font-bold text-lg">Credit Management</h4>
                                <p className="text-xs text-slate-500 mt-1">Configure packages and consumption rates</p>
                            </div>
                        </div>
                        
                        <div className="space-y-6">
                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em] mb-4 block pl-1">Purchase Packages</label>
                                <div className="space-y-3">
                                    {creditPackages.map((pkg, idx) => (
                                        <div key={pkg.id} className="grid grid-cols-5 gap-3 items-end bg-white/5 p-4 rounded-2xl border border-white/5">
                                            <div className="col-span-2 space-y-1">
                                                <label className="text-[8px] uppercase font-black text-slate-600 tracking-tighter pl-1">Credits</label>
                                                <input 
                                                    type="number"
                                                    value={pkg.credits}
                                                    onChange={(e) => {
                                                        const newPkgs = [...creditPackages];
                                                        newPkgs[idx].credits = parseInt(e.target.value) || 0;
                                                        setCreditPackages(newPkgs);
                                                    }}
                                                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500/50 text-white font-bold"
                                                />
                                            </div>
                                            <div className="col-span-2 space-y-1">
                                                <label className="text-[8px] uppercase font-black text-slate-600 tracking-tighter pl-1">Price (GHS)</label>
                                                <input 
                                                    type="number"
                                                    value={pkg.amount}
                                                    onChange={(e) => {
                                                        const newPkgs = [...creditPackages];
                                                        newPkgs[idx].amount = parseInt(e.target.value) || 0;
                                                        setCreditPackages(newPkgs);
                                                    }}
                                                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-blue-500/50 text-white font-bold"
                                                />
                                            </div>
                                            <button 
                                                onClick={() => setCreditPackages(creditPackages.filter((_, i) => i !== idx))}
                                                className="h-[42px] bg-red-500/10 text-red-500 rounded-xl hover:bg-red-500/20 transition-all flex items-center justify-center border border-red-500/20"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                    <button 
                                        onClick={() => setCreditPackages([...creditPackages, { id: Date.now().toString(), credits: 0, amount: 0 }])}
                                        className="w-full py-4 border border-dashed border-white/10 rounded-2xl text-slate-500 hover:text-white hover:border-white/20 transition-all text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"
                                    >
                                        <Plus className="w-4 h-4" /> Add New Package
                                    </button>
                                </div>
                            </div>

                            <hr className="border-white/5" />

                            <div>
                                <label className="text-[10px] uppercase font-black text-slate-500 tracking-[0.2em] mb-4 block pl-1">Consumption Rates (Actions)</label>
                                <div className="grid grid-cols-1 gap-4">
                                    <div className="flex items-center justify-between bg-white/5 px-6 py-4 rounded-2xl border border-white/5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 bg-blue-500/10 rounded-lg flex items-center justify-center text-blue-500">
                                                <Send className="w-4 h-4" />
                                            </div>
                                            <span className="text-sm font-bold text-slate-300">Text Prompt</span>
                                        </div>
                                        <input 
                                            type="number"
                                            value={creditCosts.textPrompt}
                                            onChange={(e) => setCreditCosts({...creditCosts, textPrompt: parseInt(e.target.value) || 0})}
                                            className="w-20 bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-sm text-center font-black text-blue-400 outline-none"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between bg-white/5 px-6 py-4 rounded-2xl border border-white/5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 bg-purple-500/10 rounded-lg flex items-center justify-center text-purple-500">
                                                <ImageIcon className="w-4 h-4" />
                                            </div>
                                            <span className="text-sm font-bold text-slate-300">Image Generation</span>
                                        </div>
                                        <input 
                                            type="number"
                                            value={creditCosts.imageGen}
                                            onChange={(e) => setCreditCosts({...creditCosts, imageGen: parseInt(e.target.value) || 0})}
                                            className="w-20 bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-sm text-center font-black text-purple-400 outline-none"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between bg-white/5 px-6 py-4 rounded-2xl border border-white/5">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 bg-emerald-500/10 rounded-lg flex items-center justify-center text-emerald-500">
                                                <Mic className="w-4 h-4" />
                                            </div>
                                            <span className="text-sm font-bold text-slate-300">Voice Prompt</span>
                                        </div>
                                        <input 
                                            type="number"
                                            value={creditCosts.voicePrompt}
                                            onChange={(e) => setCreditCosts({...creditCosts, voicePrompt: parseInt(e.target.value) || 0})}
                                            className="w-20 bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-sm text-center font-black text-emerald-400 outline-none"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                  {/* Paystack Integration */}
                  <div className="glass p-8 rounded-[32px] border-white/5 space-y-6">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-white/5 rounded-2xl flex items-center justify-center">
                        <CreditCard className="w-6 h-6 text-blue-500" />
                      </div>
                      <div>
                        <h4 className="font-bold text-lg">Paystack Integration</h4>
                        <p className="text-xs text-slate-500 mt-1">Manage your payment gateway credentials</p>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div className="space-y-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest pl-1">Public API Key</label>
                        <input 
                          type="password"
                          value={paystackKey}
                          onChange={(e) => setPaystackKey(e.target.value)}
                          placeholder="pk_live_..."
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm outline-none focus:border-blue-500/50 transition-colors text-white"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-[10px] uppercase font-black text-slate-500 tracking-widest pl-1">Secret API Key</label>
                        <input 
                          type="password"
                          value={paystackSecretKey}
                          onChange={(e) => setPaystackSecretKey(e.target.value)}
                          placeholder="sk_live_..."
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-sm outline-none focus:border-blue-500/50 transition-colors text-white"
                        />
                      </div>
                    </div>

                    <button 
                      onClick={saveSettings}
                      disabled={isSavingSettings}
                      className="w-full bg-blue-600 text-white font-black py-4 rounded-2xl shadow-xl active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSavingSettings ? (
                        <>
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                          <span>Syncing...</span>
                        </>
                      ) : (
                        "Save Configuration"
                      )}
                    </button>
                  </div>

                  <div className="p-6 bg-yellow-500/5 border border-yellow-500/10 rounded-3xl">
                    <p className="text-xs text-yellow-500/80 leading-relaxed italic">
                      "API keys and branding assets are stored securely. Changes reflect instantly to all users."
                    </p>
                  </div>
                </div>
              ) : adminTab === 'doctors' ? (
                <div className="space-y-6">
                  <div className="flex justify-between items-center px-2">
                    <h3 className="text-[10px] uppercase font-black text-slate-500 tracking-widest">Medical Staff</h3>
                    <button 
                      onClick={() => {
                        setShowDoctorForm(!showDoctorForm);
                        if (showDoctorForm) {
                          setEditingDoctorId(null);
                          setDiagDoctor({ name: "", specialty: "", email: "", bio: "", photoUrl: "", consultationFee: 50, durationMinutes: 30, isActive: true });
                        }
                      }}
                      className="text-xs font-bold text-blue-500 flex items-center gap-1"
                    >
                      {showDoctorForm ? "Cancel" : <><Plus className="w-3 h-3" /> Add Doctor</>}
                    </button>
                  </div>

                  {showDoctorForm && (
                     <motion.form 
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      onSubmit={addDoctor}
                      className="glass p-6 rounded-[32px] border-blue-500/30 bg-blue-500/5 space-y-4"
                    >
                       <div className="space-y-4">
                        <h4 className="text-xs font-black text-blue-400 uppercase tracking-widest px-2">
                          {editingDoctorId ? "Update Profile" : "Register New Staff"}
                        </h4>
                        <input 
                          required
                          value={diagDoctor.name}
                          onChange={(e) => setDiagDoctor({...diagDoctor, name: e.target.value})}
                          placeholder="Doctor Name (e.g., Dr. Kwame Mensah)"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none"
                        />
                        <input 
                          required
                          value={diagDoctor.specialty}
                          onChange={(e) => setDiagDoctor({...diagDoctor, specialty: e.target.value})}
                          placeholder="Specialty (e.g., Cardiologist)"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none"
                        />
                        <input 
                          required
                          value={diagDoctor.email}
                          onChange={(e) => setDiagDoctor({...diagDoctor, email: e.target.value})}
                          placeholder="Email Address"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none"
                        />
                        <textarea 
                          value={diagDoctor.bio}
                          onChange={(e) => setDiagDoctor({...diagDoctor, bio: e.target.value})}
                          placeholder="Brief Bio"
                          className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none h-24 resize-none"
                        />
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1">
                            <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Fee (GHS)</label>
                            <input 
                              type="number"
                              required
                              value={diagDoctor.consultationFee}
                              onChange={(e) => setDiagDoctor({...diagDoctor, consultationFee: parseFloat(e.target.value)})}
                              className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none focus:border-blue-500"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Duration (Mins)</label>
                            <input 
                              type="number"
                              required
                              value={diagDoctor.durationMinutes}
                              onChange={(e) => setDiagDoctor({...diagDoctor, durationMinutes: parseInt(e.target.value)})}
                              className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-3 text-sm outline-none focus:border-blue-500"
                            />
                          </div>
                        </div>
                        
                        <div className="space-y-3">
                          <div className="flex justify-between items-center px-2">
                            <label className="text-[10px] uppercase font-bold text-slate-500">Weekly Availability</label>
                            <button 
                              type="button"
                              onClick={() => {
                                const slots = [...(diagDoctor.availability || [])];
                                slots.push({ day: 'Monday', startTime: '09:00', endTime: '17:00' });
                                setDiagDoctor({...diagDoctor, availability: slots});
                              }}
                              className="text-[10px] font-bold text-blue-500"
                            >
                              + Add Slot
                            </button>
                          </div>
                          <div className="space-y-2">
                            {(diagDoctor.availability || []).map((slot, idx) => (
                              <div key={idx} className="flex gap-2 items-center bg-white/5 p-2 rounded-xl">
                                <select 
                                  value={slot.day}
                                  onChange={(e) => {
                                    const slots = [...diagDoctor.availability!];
                                    slots[idx].day = e.target.value;
                                    setDiagDoctor({...diagDoctor, availability: slots});
                                  }}
                                  className="bg-transparent text-xs text-slate-300 outline-none flex-1"
                                >
                                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(d => (
                                    <option key={d} value={d} className="bg-[#0a0a0c]">{d}</option>
                                  ))}
                                </select>
                                <div className="flex items-center gap-1">
                                  <input 
                                    type="time"
                                    value={slot.startTime}
                                    onChange={(e) => {
                                      const slots = [...diagDoctor.availability!];
                                      slots[idx].startTime = e.target.value;
                                      setDiagDoctor({...diagDoctor, availability: slots});
                                    }}
                                    className="bg-transparent text-[10px] text-slate-300 outline-none"
                                  />
                                  <span className="text-slate-600">-</span>
                                  <input 
                                    type="time"
                                    value={slot.endTime}
                                    onChange={(e) => {
                                      const slots = [...diagDoctor.availability!];
                                      slots[idx].endTime = e.target.value;
                                      setDiagDoctor({...diagDoctor, availability: slots});
                                    }}
                                    className="bg-transparent text-[10px] text-slate-300 outline-none"
                                  />
                                </div>
                                <button 
                                  type="button"
                                  onClick={() => {
                                    const slots = diagDoctor.availability!.filter((_, i) => i !== idx);
                                    setDiagDoctor({...diagDoctor, availability: slots});
                                  }}
                                  className="text-red-500 p-1"
                                >
                                  <Minus className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="text-[10px] uppercase font-bold text-slate-500 ml-2">Photo or Credential (Image/PDF)</label>
                          <div className="flex gap-4 items-center">
                            <label className="flex-1 cursor-pointer">
                              <div className="w-full bg-white/5 border-2 border-dashed border-white/10 hover:border-blue-500/50 rounded-2xl p-4 transition-all flex flex-col items-center justify-center gap-2 group">
                                <Plus className="w-6 h-6 text-slate-500 group-hover:text-blue-500" />
                                <span className="text-xs text-slate-400">Click to upload photo or CV</span>
                                <input 
                                  type="file" 
                                  className="hidden" 
                                  accept="image/*,.pdf"
                                  onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                      if (file.size > 800000) {
                                        alert("File too large. Max 800KB for direct storage.");
                                        return;
                                      }
                                      const reader = new FileReader();
                                      reader.onloadend = () => {
                                        setDiagDoctor({...diagDoctor, photoUrl: reader.result as string});
                                      };
                                      reader.readAsDataURL(file);
                                    }
                                  }}
                                />
                              </div>
                            </label>
                            {diagDoctor.photoUrl && (
                              <div className="w-20 h-20 bg-white/5 rounded-2xl border border-white/10 overflow-hidden flex items-center justify-center">
                                {diagDoctor.photoUrl.startsWith("data:application/pdf") ? (
                                  <div className="text-center">
                                    <ShieldCheck className="w-8 h-8 text-blue-500" />
                                    <p className="text-[8px] font-bold">PDF</p>
                                  </div>
                                ) : (
                                  <img src={diagDoctor.photoUrl} className="w-full h-full object-cover" />
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <button className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg">
                        {editingDoctorId ? "Save Changes" : "Confirm Registration"}
                      </button>
                    </motion.form>
                  )}

                  <div className="grid grid-cols-1 gap-4">
                    {doctors.map(doc => (
                      <div key={doc.id} className="glass p-5 rounded-3xl border-white/5 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          {doc.photoUrl ? (
                            <div className="w-12 h-12 rounded-xl overflow-hidden border border-white/10 flex items-center justify-center bg-blue-500/20">
                              {doc.photoUrl.startsWith("data:application/pdf") ? (
                                <ShieldCheck className="w-6 h-6 text-blue-400" />
                              ) : (
                                <img src={doc.photoUrl} className="w-full h-full object-cover" />
                              )}
                            </div>
                          ) : (
                            <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center text-blue-400 font-bold text-xl">
                              {doc.name[0]}
                            </div>
                          )}
                          <div>
                            <p className="font-bold text-sm">{doc.name}</p>
                            <p className="text-[9px] uppercase font-bold text-slate-500">{doc.specialty}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => {
                              setEditingDoctorId(doc.id);
                              setDiagDoctor({ ...doc });
                              setShowDoctorForm(true);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="p-2 text-blue-400 hover:bg-blue-500/10 rounded-xl transition-colors"
                            title="Edit Doctor"
                          >
                            <CreditCard className="w-4 h-4" />
                          </button>
                          {doc.photoUrl && (
                            <button 
                              onClick={() => {
                                const win = window.open();
                                if (win) {
                                  if (doc.photoUrl.startsWith("data:application/pdf")) {
                                    win.document.write(`<iframe src="${doc.photoUrl}" frameborder="0" style="border:0; top:0px; left:0px; bottom:0px; right:0px; width:100%; height:100%;" allowfullscreen></iframe>`);
                                  } else {
                                    win.document.write(`<img src="${doc.photoUrl}" style="max-width: 100%;">`);
                                  }
                                }
                              }}
                              className="p-2 text-blue-400 hover:bg-blue-500/10 rounded-xl transition-colors"
                              title="View Document"
                            >
                              <ImageIcon className="w-4 h-4" />
                            </button>
                          )}
                          <button onClick={() => deleteDoctor(doc.id)} className="p-2 text-red-500 hover:bg-red-500/10 rounded-xl transition-colors">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <h3 className="text-[10px] uppercase font-black text-slate-500 tracking-widest px-2">Pending Consultations</h3>
                  <div className="space-y-4">
                    {appointments.length === 0 ? (
                      <p className="text-center py-10 text-slate-600 italic text-sm">No appointments scheduled</p>
                    ) : (
                      appointments.sort((a,b) => b.dateTime.localeCompare(a.dateTime)).map(app => (
                        <div key={app.id} className="glass p-5 rounded-[32px] border-white/5 space-y-4">
                          <div className="flex justify-between items-start">
                            <div>
                              <p className="font-bold text-white">{app.patientName}</p>
                              <p className="text-xs text-slate-500 font-medium">with {app.doctorName}</p>
                            </div>
                            <span className={cn(
                              "text-[10px] font-black uppercase px-2 py-1 rounded-full",
                              app.status === 'confirmed' ? "bg-emerald-500/20 text-emerald-400" :
                              app.status === 'pending' ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"
                            )}>
                              {app.status}
                            </span>
                          </div>
                          
                          <div className="flex items-center gap-2 text-slate-400 text-xs font-bold">
                            <Plus className="w-3 h-3" />
                            {new Date(app.dateTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                            {" - "}
                            {app.endTime ? new Date(app.endTime).toLocaleTimeString([], { timeStyle: 'short' }) : 'Unknown End'}
                          </div>

                          <div className="flex items-center gap-4 text-[10px] font-black text-slate-500 uppercase tracking-widest bg-white/5 p-3 rounded-2xl">
                             <div className="flex-1">
                               <p className="text-slate-600 mb-1">Payment Status</p>
                               <p className={cn(app.paymentRef ? "text-emerald-400" : "text-amber-400")}>
                                 {app.paymentRef ? `Paid GHS ${app.amountPaid}` : "Unpaid / Local"}
                               </p>
                             </div>
                             {app.paymentRef && (
                               <div className="flex-1">
                                 <p className="text-slate-600 mb-1">Reference</p>
                                 <p className="truncate font-mono">{app.paymentRef}</p>
                               </div>
                             )}
                          </div>

                          {app.status === 'pending' && (
                            <div className="flex gap-2">
                              <button 
                                onClick={() => {
                                  const link = prompt("Enter Google Meet link:");
                                  if (link) updateAppointmentStatus(app.id, 'confirmed', link);
                                }}
                                className="flex-1 bg-emerald-500 text-white font-bold py-2 rounded-xl text-xs"
                              >
                                Confirm & Link
                              </button>
                              <button 
                                onClick={() => updateAppointmentStatus(app.id, 'cancelled')}
                                className="flex-1 bg-white/5 text-red-500 font-bold py-2 rounded-xl text-xs"
                              >
                                Reject
                              </button>
                            </div>
                          )}

                          {app.status === 'confirmed' && (
                            <div className="p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl flex items-center justify-between">
                              <span className="text-[10px] text-emerald-400 font-bold truncate max-w-[200px]">{app.meetLink}</span>
                              <button onClick={() => window.open(app.meetLink, '_blank')} className="text-emerald-400"><Download className="w-4 h-4" /></button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col relative z-30">
        <div className="flex-1 overflow-y-auto p-4 lg:p-10 space-y-8 custom-scrollbar relative z-10 w-full max-w-4xl mx-auto">
          {deferredPrompt && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="group relative p-8 lg:p-10 bg-gradient-to-br from-blue-600 to-indigo-700 border border-white/20 rounded-[40px] mb-6 flex flex-col md:flex-row items-center gap-8 shadow-2xl shadow-blue-500/20 overflow-hidden"
            >
              <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-[80px] -mr-32 -mt-32"></div>
              <div className="absolute bottom-0 left-0 w-48 h-48 bg-black/10 rounded-full blur-[60px] -ml-24 -mb-24"></div>
              
              <div className="relative z-10 w-20 h-20 bg-white/20 backdrop-blur-xl rounded-[32px] flex items-center justify-center shrink-0 shadow-inner group-hover:scale-110 transition-transform duration-500">
                <Download className="w-10 h-10 text-white" />
              </div>
              
              <div className="relative z-10 flex-1 text-center md:text-left">
                <div className="flex items-center justify-center md:justify-start gap-3 mb-2">
                  <h4 className="text-2xl font-black text-white italic tracking-tight uppercase">Install eCare GH</h4>
                  <div className="px-3 py-1 bg-white/20 rounded-full text-[8px] font-black uppercase tracking-widest text-white border border-white/30 backdrop-blur-md">Recommended</div>
                </div>
                <p className="text-sm lg:text-base text-blue-100 font-medium max-w-sm">Add eCare to your home screen for faster launch and a smoother experience on your phone.</p>
              </div>

              <div className="relative z-10 flex flex-col items-center gap-3 w-full md:w-auto">
                <button 
                  onClick={installPWA}
                  className="w-full md:w-auto bg-white text-blue-600 px-10 py-5 rounded-3xl text-sm font-black uppercase tracking-widest shadow-xl hover:bg-blue-50 transition-all hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-3 min-w-[200px]"
                >
                  Install App <Plus className="w-4 h-4" />
                </button>
                <div className="flex flex-col items-center gap-2">
                  <p className="text-[10px] text-white/50 font-bold uppercase tracking-widest leading-none">Free to use • 1.2MB Package</p>
                  <button 
                    onClick={() => setDeferredPrompt(null)}
                    className="text-[9px] text-white/30 hover:text-white/60 font-black uppercase tracking-widest transition-colors"
                  >
                    Maybe later
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        <div className="flex flex-col gap-4 mb-4">
          <div className="flex justify-center">
            <div className="bg-blue-500/10 text-blue-400 text-[10px] px-4 py-1.5 rounded-full uppercase tracking-[0.2em] font-black border border-blue-500/10 backdrop-blur-md">
              Biometric Link Established
            </div>
          </div>

          {userAppointments.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-4 no-scrollbar">
              {userAppointments.map(app => (
                <div key={app.id} className="glass min-w-[240px] p-4 rounded-3xl border-emerald-500/30 bg-emerald-500/5 space-y-3">
                  <div className="flex justify-between items-start">
                    <h4 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest leading-none">Your Consultation</h4>
                    <span className={cn(
                      "text-[8px] font-black uppercase px-2 py-0.5 rounded-full",
                      app.status === 'confirmed' ? "bg-emerald-500 text-white" : "bg-amber-500 text-white"
                    )}>
                      {app.status}
                    </span>
                  </div>
                  <p className="text-xs font-bold">{app.doctorName}</p>
                  <p className="text-[10px] text-slate-400">{new Date(app.dateTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</p>
                  {app.meetLink && (
                    <button 
                      onClick={() => window.open(app.meetLink, '_blank')}
                      className="w-full bg-emerald-500 text-white py-2 rounded-xl text-[10px] font-bold flex items-center justify-center gap-2"
                    >
                      <Download className="w-3 h-3" /> Join Google Meet
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {messages.length === 0 && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            className="flex flex-col items-center justify-center h-full text-center space-y-6"
          >
            <div className="glass p-8 rounded-[32px] max-w-[85%] border-white/5">
              <span className="text-3xl mb-3 block">🇬🇭 Akwaaba!</span>
              <p className="text-sm text-slate-300 font-medium leading-relaxed italic">
                Welcome to <span className="text-blue-500 font-black">eCare GH AI</span>. Personalized healthcare at your fingertips. How can I assist you today?
              </p>
            </div>
          </motion.div>
        )}

        {messages.map((m, i) => (
          <motion.div 
            key={i} 
            initial={{ opacity: 0, x: m.role === 'user' ? 20 : -20 }}
            animate={{ opacity: 1, x: 0 }}
            className={cn("flex w-full mb-2", m.role === 'user' ? "justify-end" : "justify-start")}
          >
            <div className={cn(
              "max-w-[90%] p-4 rounded-3xl text-[14px] leading-relaxed relative group shadow-lg underline-offset-4",
              m.role === 'user' 
                ? "bg-gradient-to-br from-blue-600 to-indigo-700 text-white rounded-tr-none border border-white/10" 
                : "glass-dark text-slate-200 rounded-tl-none border-white/10"
            )}>
              {m.role === 'model' && (
                <div className="absolute -top-7 left-1 text-[10px] font-black text-blue-500 uppercase tracking-widest flex items-center gap-2">
                  Health Intelligence
                  <button onClick={() => playAudio(m.content)} className="hover:text-blue-300 transition-colors">
                    <Volume2 className={cn("w-3 h-3", isSpeaking && "animate-pulse")} />
                  </button>
                </div>
              )}
              <div className="markdown-body">
                <ReactMarkdown>{m.content}</ReactMarkdown>
              </div>

              {m.attachments && m.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {m.attachments.map((att, idx) => (
                    <div key={idx} className="relative group">
                      {att.type.startsWith('image/') ? (
                        <div className="w-20 h-20 rounded-xl overflow-hidden border border-white/20 shadow-md">
                          <img src={att.data} alt={att.name} className="w-full h-full object-cover" />
                        </div>
                      ) : att.type === 'application/pdf' ? (
                        <div className="w-20 h-20 bg-red-500/10 rounded-xl border border-red-500/20 flex flex-col items-center justify-center p-2 text-center overflow-hidden">
                          <Download className="w-4 h-4 text-red-500 mb-1" />
                          <span className="text-[8px] font-bold text-red-400 line-clamp-2 leading-tight uppercase tracking-tighter">{att.name}</span>
                        </div>
                      ) : (
                        <div className="w-20 h-20 bg-blue-500/10 rounded-xl border border-blue-500/20 flex flex-col items-center justify-center p-2 text-center overflow-hidden">
                          <Plus className="w-4 h-4 text-blue-500 mb-1" />
                          <span className="text-[8px] font-bold text-blue-400 line-clamp-2 leading-tight uppercase tracking-tighter">{att.name}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {m.role === 'model' && (
                <div className="mt-4 space-y-2">
                  {doctors.filter(d => m.content.toLowerCase().includes(d.name.toLowerCase()) || m.content.toLowerCase().includes(d.specialty.toLowerCase())).slice(0, 1).map(doc => (
                    <div key={doc.id} className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4 space-y-3">
                      <div className="flex items-center gap-3">
                         {doc.photoUrl && !doc.photoUrl.startsWith("data:application/pdf") ? (
                           <div className="w-10 h-10 rounded-xl overflow-hidden border border-white/10 shadow-lg">
                             <img src={doc.photoUrl} className="w-full h-full object-cover" />
                           </div>
                         ) : (
                           <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center text-white font-bold">
                              {doc.name[0]}
                            </div>
                         )}
                          <div>
                            <p className="text-xs font-bold text-blue-400 leading-none mb-1">Recommended Professional</p>
                            <p className="text-sm font-bold">{doc.name}</p>
                            <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">GHS {doc.consultationFee || 0} • {doc.durationMinutes || 0}m Session</p>
                          </div>
                      </div>
                      <button 
                        onClick={() => { setSelectedDoctor(doc); setShowBookingModal(true); }}
                        className="w-full bg-blue-600 text-white font-bold py-2 rounded-xl text-xs hover:bg-blue-500 transition-colors shadow-lg shadow-blue-500/20"
                      >
                        Book Video Consultation
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className={cn("text-[9px] mt-2 font-bold tracking-tighter opacity-40", m.role === 'user' ? "text-right" : "text-left")}>
                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </motion.div>
        ))}
        {isTyping && (
          <div className="flex justify-start">
            <div className="glass-dark p-4 rounded-3xl rounded-tl-none border-white/10">
              <div className="flex gap-1.5 px-2">
                <motion.span animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1.5 h-1.5 bg-blue-500 rounded-full" />
                <motion.span animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1.5 h-1.5 bg-blue-400 rounded-full" />
                <motion.span animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1.5 h-1.5 bg-blue-300 rounded-full" />
              </div>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      <div className="glass-dark p-6 border-t border-white/5 z-10 bottom-0 sticky">
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar">
            {attachments.map((att, idx) => (
              <div key={idx} className="relative group shrink-0">
                {att.type.startsWith('image/') ? (
                  <div className="w-16 h-16 rounded-2xl overflow-hidden border border-blue-500/30">
                    <img src={att.data} alt={att.name} className="w-full h-full object-cover" />
                  </div>
                ) : (
                  <div className="w-16 h-16 bg-blue-500/10 rounded-2xl border border-blue-500/30 flex flex-col items-center justify-center p-2 text-center overflow-hidden">
                    {att.type === 'application/pdf' ? <Download className="w-4 h-4 text-blue-500" /> : <Plus className="w-4 h-4 text-blue-500" />}
                    <span className="text-[6px] font-black text-blue-400 line-clamp-1 mt-1 uppercase tracking-tighter">{att.name}</span>
                  </div>
                )}
                <button 
                  onClick={() => removeAttachment(idx)}
                  className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full p-1 shadow-lg hover:scale-110 transition-transform"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {isRecording && (
          <div className="flex justify-center mb-4">
            <motion.div 
              animate={{ scale: [1, 1.1, 1] }} 
              transition={{ repeat: Infinity, duration: 2 }}
              className="bg-red-500/10 text-red-400 text-[10px] px-6 py-2 rounded-full border border-red-500/20 font-black uppercase tracking-widest flex items-center gap-3"
            >
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
              Recording Audio...
            </motion.div>
          </div>
        )}
        
        <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-[28px] p-2 ring-blue-500/20 focus-within:ring-4 transition-all shadow-2xl">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            className="hidden" 
            multiple
            accept="image/*,.pdf"
          />
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="p-3 hover:bg-white/10 text-slate-400 hover:text-white rounded-2xl transition-all active:scale-95"
          >
            <ImageIcon className="w-5 h-5" />
          </button>
          <input 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={isRecording ? "Listening..." : "Describe your health concern..."}
            className="flex-1 bg-transparent border-none outline-none text-sm text-white placeholder:text-slate-500 font-medium px-2"
          />
          {input.trim() ? (
            <button 
              onClick={() => sendMessage()}
              className="bg-white text-black p-3 rounded-2xl shadow-xl active:scale-90 transition-transform flex items-center justify-center font-bold"
            >
              <Send className="w-5 h-5" />
            </button>
          ) : (
            <button 
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              className={cn(
                "p-3 rounded-2xl transition-all active:scale-90 flex items-center justify-center",
                isRecording 
                  ? "bg-red-500 text-white shadow-[0_0_20px_rgba(239,68,68,0.3)]" 
                  : "bg-white/10 text-slate-400 hover:text-white"
              )}
            >
              {isRecording ? <StopCircle className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
          )}
        </div>
        <p className="text-[10px] text-center text-slate-600 mt-4 font-bold uppercase tracking-widest px-4 opacity-50">
          Informational Tool Only • Professional Medical Grade Encryption
        </p>
      </div>

      <div className="h-2 w-32 bg-white/10 rounded-full mx-auto mb-2 opacity-50"></div>

      {/* Booking Modal */}
      <AnimatePresence>
        {showBookingModal && selectedDoctor && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="glass p-8 rounded-[40px] border-blue-500/30 bg-[#0a0a0c] w-full max-w-sm space-y-6 relative overflow-hidden"
            >
              <div className="absolute top-0 right-0 p-4">
                <button onClick={() => setShowBookingModal(false)} className="p-2 bg-white/5 rounded-full"><X className="w-5 h-5" /></button>
              </div>

              <div className="text-center space-y-4">
                <div className="w-20 h-20 bg-blue-600 rounded-[30px] mx-auto flex items-center justify-center shadow-2xl shadow-blue-500/20">
                  <CreditCard className="w-10 h-10 text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-bold italic">Schedule <span className="text-blue-500">Call</span></h3>
                  <p className="text-xs text-slate-500 font-medium mt-1">Consultation with {selectedDoctor.name}</p>
                  <p className="text-lg font-black text-white mt-2">GHS {(selectedDoctor.consultationFee || 0).toFixed(2)}</p>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{(selectedDoctor.durationMinutes || 0)} Minutes Session</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-black text-slate-500 ml-2">Preferred Date</label>
                  <input 
                    type="date"
                    value={bookingDate}
                    onChange={(e) => setBookingDate(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 text-sm outline-none focus:border-blue-500/50"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-black text-slate-500 ml-2">Available Times</label>
                  <div className="grid grid-cols-3 gap-2">
                    {bookingDate ? (
                      getAvailableSlotsForDate(selectedDoctor, bookingDate).length > 0 ? (
                        getAvailableSlotsForDate(selectedDoctor, bookingDate).map(slot => (
                          <button
                            key={slot}
                            onClick={() => setBookingTime(slot)}
                            className={cn(
                              "py-3 rounded-xl text-[10px] font-black transition-all border",
                              bookingTime === slot 
                                ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20" 
                                : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                            )}
                          >
                            {slot}
                          </button>
                        ))
                      ) : (
                        <p className="col-span-3 text-center py-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest">No slots available on this day</p>
                      )
                    ) : (
                      <p className="col-span-3 text-center py-4 text-[10px] text-slate-500 font-bold uppercase tracking-widest">Select a date first</p>
                    )}
                  </div>
                </div>
              </div>

              <button 
                onClick={handleBookingPayment}
                className="w-full bg-blue-600 text-white font-black py-4 rounded-2xl shadow-xl active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                {selectedDoctor.consultationFee > 0 ? "Pay & Book Now" : "Book Now"}
              </button>

              <p className="text-[10px] text-center text-slate-600 font-bold uppercase tracking-widest leading-relaxed">
                Consultation link will be sent to your email and dashboard once confirmed by admin.
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
        </div>
      </div>
    </div>
  </div>
);
}

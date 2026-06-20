import React, { useState, useEffect, useRef } from 'react';
import { 
  Calendar, Users, Settings as SettingsIcon, Database, 
  Lock, Unlock, Play, Save, Trash, Plus, X, 
  AlertTriangle, Download, Upload, RefreshCw, Info, HelpCircle,
  BarChart2, Share2, Camera, Copy, CheckCircle
} from 'lucide-react';
import { toPng } from 'html-to-image';
import './App.css';

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";

// Default residents with rotations and OPD days seeded from Draft.txt
const SEEDED_RESIDENTS = [
  { name: "จิรภัตรา", rotation: "Cardio", opd_days: [], blocked_dates: [] },
  { name: "ชนกนันท์", rotation: "ICU", opd_days: ["Friday"], blocked_dates: [] },
  { name: "ณัฐพล", rotation: "Endo", opd_days: ["Tuesday"], blocked_dates: [] },
  { name: "ตะวัน", rotation: "GI", opd_days: ["Wednesday"], blocked_dates: [] },
  { name: "ธนวันต์", rotation: "Onco", opd_days: ["Wednesday"], blocked_dates: [] },
  { name: "ธรรศ", rotation: "ICU", opd_days: ["Friday"], blocked_dates: [] },
  { name: "ธราธร", rotation: "Hema", opd_days: ["Tuesday"], blocked_dates: [] },
  { name: "ธีรดนย์", rotation: "GI", opd_days: ["Friday"], blocked_dates: [] },
  { name: "นราวิชญ์", rotation: "Cardio", opd_days: ["Friday"], blocked_dates: [] },
  { name: "ประภากร", rotation: "Skin/Geriatrics", opd_days: [], blocked_dates: [] },
  { name: "ภูริภัค", rotation: "Nephro", opd_days: ["Wednesday"], blocked_dates: [] },
  { name: "ยลรดา", rotation: "Chest", opd_days: ["Friday"], blocked_dates: [] },
  { name: "รุ่งไพลิน", rotation: "ID", opd_days: ["Friday"], blocked_dates: [] },
  { name: "วัชรพล", rotation: "Ambu", opd_days: ["Monday"], blocked_dates: [] },
  { name: "สิรภพ", rotation: "Elective", opd_days: ["Tuesday"], blocked_dates: [] },
  { name: "อภิชาต", rotation: "Rheu", opd_days: ["Monday"], blocked_dates: [] },
  { name: "อภิสรา", rotation: "Neuro", opd_days: ["Thursday"], blocked_dates: [] },
  { name: "อริศรา", rotation: "Vacation", opd_days: [], blocked_dates: [] }
];

const DEFAULT_SHIFTS = [
  { name: "MICU", display_name: "MICU", active_from_date: "", active_to_date: "" },
  { name: "CCU", display_name: "CCU", active_from_date: "", active_to_date: "" },
  { name: "ต่างแผนก", display_name: "ต่างแผนก", active_from_date: "", active_to_date: "" },
  { name: "แยกโรค", display_name: "แยกโรค", active_from_date: "2026-07-17", active_to_date: "" }
];

const DEFAULT_HOLIDAYS = {
  "2026-07-28": "วันเฉลิมพระชนมพรรษารัชกาลที่ 10"
};

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("scheduler_user");
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState(() => {
    return localStorage.getItem("scheduler_token") || null;
  });

  const [activeTab, setActiveTab] = useState("schedule");

  const [residentProfile, setResidentProfile] = useState(null);
  const [residentBlockedDates, setResidentBlockedDates] = useState([]);
  const [residentBlockedDatesDraft, setResidentBlockedDatesDraft] = useState([]);
  const [newResidentBlockedDate, setNewResidentBlockedDate] = useState("");
  const [adminMappings, setAdminMappings] = useState([]);
  const [adminOverallBlockedDates, setAdminOverallBlockedDates] = useState({});

  const GOOGLE_CLIENT_ID = "421868352697-3r5109vj4o09rpnj2f9q23f0sspv1dki.apps.googleusercontent.com"; // Change if needed

  const getAbsoluteCalendarUrl = (token) => {
    if (API_BASE.startsWith("http")) {
      return `${API_BASE}/api/calendar/${token}.ics`;
    }
    return `${window.location.origin}${API_BASE}/api/calendar/${token}.ics`;
  };

  const fetchWithAuth = async (url, options = {}) => {
    const headers = {
      ...options.headers,
      "Authorization": token ? `Bearer ${token}` : ""
    };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      handleLogout();
      throw new Error("Session expired. Please log in again.");
    }
    return res;
  };

  useEffect(() => {
    if (!user) {
      const renderGoogleButton = () => {
        const btnElement = document.getElementById("google-signin-button");
        if (window.google && btnElement) {
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGoogleCallback,
          });
          window.google.accounts.id.renderButton(
            btnElement,
            { theme: "outline", size: "large", width: 280 }
          );
          return true;
        }
        return false;
      };

      if (!renderGoogleButton()) {
        const interval = setInterval(() => {
          if (renderGoogleButton()) {
            clearInterval(interval);
          }
        }, 300);
        return () => clearInterval(interval);
      }
    }
  }, [user]);

  useEffect(() => {
    if (user && !user.is_admin && user.resident_name) {
      fetchResidentProfile();
    }
    if (user && user.is_admin) {
      fetchAdminData();
    }
  }, [user]);

  const handleGoogleCallback = async (response) => {
    setIsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: response.credential })
      });
      if (!res.ok) {
        throw new Error("Failed to authenticate with Google");
      }
      const data = await res.json();
      if (data.status === "SUCCESS") {
        setUser(data.user);
        setToken(response.credential);
        localStorage.setItem("scheduler_user", JSON.stringify(data.user));
        localStorage.setItem("scheduler_token", response.credential);
        setSuccessMsg(`Welcome, ${data.user.name}!`);
      }
    } catch (e) {
      setErrorMsg(e.message || "Failed to log in");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("scheduler_user");
    localStorage.removeItem("scheduler_token");
    setSuccessMsg("Logged out successfully.");
  };

  const handleBypassLogin = () => {
    const mockAdmin = {
      email: "tuinui@example.com",
      name: "Tui Nui (Admin Bypass)",
      picture: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&q=80",
      is_admin: true,
      resident_name: null,
      ical_token: null
    };
    setUser(mockAdmin);
    setToken("mock-token-admin");
    localStorage.setItem("scheduler_user", JSON.stringify(mockAdmin));
    localStorage.setItem("scheduler_token", "mock-token-admin");
    setSuccessMsg("Logged in as Admin (Bypass)");
  };

  const handleBypassResidentLogin = () => {
    const mockResident = {
      email: "resident@example.com",
      name: "Mock Resident (Bypass)",
      picture: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=80&q=80",
      is_admin: false,
      resident_name: null,
      ical_token: null
    };
    setUser(mockResident);
    setToken("mock-token-resident");
    localStorage.setItem("scheduler_user", JSON.stringify(mockResident));
    localStorage.setItem("scheduler_token", "mock-token-resident");
    setSuccessMsg("Logged in as Resident (Bypass)");
  };

  const fetchResidentProfile = async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/resident/profile`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "SUCCESS") {
          setResidentProfile(data);
          setResidentBlockedDates(data.blocked_dates);
          setResidentBlockedDatesDraft(data.blocked_dates);
        } else if (data.status === "UNMAPPED") {
          setUser(prev => ({ ...prev, resident_name: null }));
        }
      }
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSyncBlockedDates = async () => {
    setIsLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/resident/blocked_dates/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dates: residentBlockedDatesDraft })
      });
      if (res.ok) {
        setSuccessMsg("บันทึกคำขอวันลาเรียบร้อยแล้ว! (Vacation requests submitted successfully)");
        fetchResidentProfile();
      } else {
        const err = await res.json();
        throw new Error(err.detail || "Failed to save vacation requests");
      }
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddResidentBlockedDate = async (dateVal) => {
    if (!dateVal) return;
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/resident/blocked_dates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateVal })
      });
      if (res.ok) {
        setSuccessMsg("Blocked date added.");
        fetchResidentProfile();
      } else {
        const err = await res.json();
        throw new Error(err.detail || "Failed to add blocked date");
      }
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteResidentBlockedDate = async (dateVal) => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/resident/blocked_dates/${dateVal}`, {
        method: "DELETE"
      });
      if (res.ok) {
        setSuccessMsg("Blocked date removed.");
        fetchResidentProfile();
      } else {
        const err = await res.json();
        throw new Error(err.detail || "Failed to remove blocked date");
      }
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleMapProfile = async (selectedName) => {
    if (!selectedName) return;
    setIsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/resident/map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resident_name: selectedName })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "SUCCESS") {
          const updatedUser = { ...user, resident_name: data.resident_name, ical_token: data.ical_token };
          setUser(updatedUser);
          localStorage.setItem("scheduler_user", JSON.stringify(updatedUser));
          setSuccessMsg(`Linked successfully to profile: ${data.resident_name}`);
        }
      } else {
        const err = await res.json();
        throw new Error(err.detail || "Failed to link profile");
      }
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAdminData = async () => {
    try {
      const resMappings = await fetchWithAuth(`${API_BASE}/api/admin/mappings`);
      if (resMappings.ok) {
        const data = await resMappings.json();
        setAdminMappings(data);
      }
      const resBlocked = await fetchWithAuth(`${API_BASE}/api/admin/blocked_dates`);
      if (resBlocked.ok) {
        const data = await resBlocked.json();
        setAdminOverallBlockedDates(data);
      }
    } catch (e) {
      console.error("Failed to fetch admin data:", e);
    }
  };

  const handleUnmapResident = async (name) => {
    if (!confirm(`Are you sure you want to unlink the Google account for ${name}?`)) return;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/admin/unmap/${name}`, {
        method: "POST"
      });
      if (res.ok) {
        setSuccessMsg("Resident email unlinked successfully.");
        fetchAdminData();
      }
    } catch (e) {
      setErrorMsg("Failed to unlink resident email");
    }
  };

  // Scheduling Configurations
  const [blockName, setBlockName] = useState("Block 1: 1 ก.ค. - 1 ส.ค. 69");
  const [startDate, setStartDate] = useState("2026-07-01");
  const [endDate, setEndDate] = useState("2026-08-01");
  const [residents, setResidents] = useState(() => {
    // Try to load from localStorage or fall back to seeds
    const saved = localStorage.getItem("scheduler_residents");
    return saved ? JSON.parse(saved) : SEEDED_RESIDENTS;
  });
  const [shiftTypes, setShiftTypes] = useState(DEFAULT_SHIFTS);
  const [holidays, setHolidays] = useState(DEFAULT_HOLIDAYS);
  const [prevAssignments, setPrevAssignments] = useState([]);

  // Active Schedule State
  const [assignments, setAssignments] = useState([]);
  const [violations, setViolations] = useState([]);
  const [residentStats, setResidentStats] = useState([]);

  // Database Management
  const [savedBlocks, setSavedBlocks] = useState([]);
  const [selectedBlockId, setSelectedBlockId] = useState("");

  // Comparison Statistics States
  const [statsData, setStatsData] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsSelectedBlock, setStatsSelectedBlock] = useState("cumulative");
  const [statsSortField, setStatsSortField] = useState("total_hours");
  const [statsSortAsc, setStatsSortAsc] = useState(false);

  // UI States
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [draggedResident, setDraggedResident] = useState(null);
  const [dragOverCell, setDragOverCell] = useState(null); // {date, shift}
  
  // Share Modal states
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareLayout, setShareLayout] = useState("table"); // "table" | "split" | "residents"
  const [isGeneratingShare, setIsGeneratingShare] = useState(false);
  const [shareNotification, setShareNotification] = useState("");
  const shareCardRef = useRef(null);

  // Resident edit temp state
  const [editingResident, setEditingResident] = useState(null);
  const [newBlockedDate, setNewBlockedDate] = useState("");

  // Holiday temp state
  const [newHolidayDate, setNewHolidayDate] = useState("");
  const [newHolidayName, setNewHolidayName] = useState("");

  // State to track resident for multi-date selection modal
  const [calendarModalResident, setCalendarModalResident] = useState(null);

  // Save residents list to localStorage on changes
  useEffect(() => {
    localStorage.setItem("scheduler_residents", JSON.stringify(residents));
  }, [residents]);

  // Fetch saved blocks on startup
  useEffect(() => {
    fetchBlocks();
  }, []);

  const fetchThaiHolidays = async () => {
    if (!startDate || !endDate) return;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/holidays?start_date=${startDate}&end_date=${endDate}`);
      if (res.ok) {
        const data = await res.json();
        setHolidays(prev => {
          const updated = { ...prev };
          data.forEach(h => {
            updated[h.date] = h.name;
          });
          return updated;
        });
      }
    } catch (e) {
      console.error("Failed to fetch holidays:", e);
    }
  };

  // Fetch holidays on date range changes
  useEffect(() => {
    fetchThaiHolidays();
  }, [startDate, endDate]);

  const syncRotationsWithCSV = async (currentBlockName) => {
    if (!currentBlockName) return;
    try {
      // Fetch rotations and OPD days in parallel
      const [rotRes, opdRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/api/rotations?block_name=${encodeURIComponent(currentBlockName)}`),
        fetchWithAuth(`${API_BASE}/api/opd?block_name=${encodeURIComponent(currentBlockName)}`)
      ]);

      let rotationMap = {};
      if (rotRes.ok) {
        rotationMap = await rotRes.json();
      }

      let opdMap = {};
      if (opdRes.ok) {
        opdMap = await opdRes.json();
      }

      setResidents(prev => {
        return prev.map(r => {
          const updated = { ...r };
          if (rotationMap[r.name]) {
            updated.rotation = rotationMap[r.name];
          }
          if (opdMap[r.name] !== undefined) {
            updated.opd_days = opdMap[r.name];
          }
          return updated;
        });
      });
    } catch (e) {
      console.error("Failed to sync rotations/OPD from CSV:", e);
    }
  };

  // Sync rotations whenever blockName changes
  useEffect(() => {
    if (blockName) {
      syncRotationsWithCSV(blockName);
    }
  }, [blockName]);

  const fetchBlocks = async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/blocks`);
      if (res.ok) {
        const data = await res.json();
        setSavedBlocks(data);
      }
    } catch (e) {
      console.error("Failed to fetch blocks from DB:", e);
    }
  };

  const fetchStatsComparison = async () => {
    setStatsLoading(true);
    setErrorMsg("");
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/stats/comparison`);
      if (res.ok) {
        const data = await res.json();
        setStatsData(data);
      } else {
        throw new Error("Failed to fetch comparison stats from backend");
      }
    } catch (e) {
      console.error("Failed to fetch stats:", e);
      setErrorMsg(e.message || "Error loading statistics comparison");
    } finally {
      setStatsLoading(false);
    }
  };



  const handleGenerate = async () => {
    setIsLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const payload = {
        block_name: blockName,
        start_date: startDate,
        end_date: endDate,
        residents: residents,
        shift_types: shiftTypes,
        holidays: Object.keys(holidays),
        prev_assignments: prevAssignments,
        current_assignments: assignments // Send current state to pin locked ones
      };

      const res = await fetchWithAuth(`${API_BASE}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Server failed to generate schedule");
      }

      const data = await res.json();
      if (data.status === "INFEASIBLE") {
        setErrorMsg("The algorithm found the schedule configuration INFEASIBLE. Please relax some hard constraints.");
      } else {
        setAssignments(data.assignments);
        setViolations(data.violations);
        setResidentStats(data.resident_stats);
        if (data.status === "FALLBACK") {
          setErrorMsg("Warning: Could not solve all constraints. A 'Best Effort' fallback schedule was created with violations.");
        } else {
          setSuccessMsg("Schedule generated successfully with zero violations!");
        }
      }
    } catch (e) {
      setErrorMsg(e.message || "Failed to generate schedule");
    } finally {
      setIsLoading(false);
    }
  };

  const handleValidate = async (updatedAssigns) => {
    try {
      const payload = {
        start_date: startDate,
        end_date: endDate,
        residents: residents,
        shift_types: shiftTypes,
        holidays: Object.keys(holidays),
        prev_assignments: prevAssignments,
        assignments: updatedAssigns
      };

      const res = await fetchWithAuth(`${API_BASE}/api/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        const data = await res.json();
        setViolations(data.violations);
        setResidentStats(data.resident_stats);
      }
    } catch (e) {
      console.error("Validation failed:", e);
    }
  };

  const handleSaveBlock = async () => {
    if (!blockName || assignments.length === 0) {
      setErrorMsg("Cannot save: generate a schedule first.");
      return;
    }
    setIsLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const payload = {
        block_name: blockName,
        start_date: startDate,
        end_date: endDate,
        residents: residents,
        assignments: assignments
      };

      const res = await fetchWithAuth(`${API_BASE}/api/blocks/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error("Failed to save to database");

      setSuccessMsg("Schedule saved to local SQLite database!");
      fetchBlocks();
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const getThaiMonthYear = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    const monthsThai = [
      "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
    ];
    const month = monthsThai[date.getMonth()];
    const yearBE = date.getFullYear() + 543;
    return `ตารางประจำเดือน ${month} พ.ศ. ${yearBE}`;
  };

  const getResidentShifts = () => {
    const resMap = {};
    residents.forEach(r => {
      resMap[r.name] = {
        rotation: r.rotation,
        shifts: []
      };
    });
    const sortedAssigns = [...assignments].sort((a, b) => a.date.localeCompare(b.date));
    sortedAssigns.forEach(a => {
      if (resMap[a.resident_name]) {
        const dayNum = a.date.split('-')[2];
        const shiftAbbr = {
          "MICU": "M",
          "CCU": "C",
          "ต่างแผนก": "ต",
          "แยกโรค": "ย"
        };
        const abbr = shiftAbbr[a.shift_type] || a.shift_type.substring(0, 1);
        resMap[a.resident_name].shifts.push(`${dayNum}(${abbr})`);
      }
    });
    return resMap;
  };

  const handleDownloadShare = async () => {
    if (!shareCardRef.current) return;
    setIsGeneratingShare(true);
    setShareNotification("กำลังสร้างรูปภาพ PNG คุณภาพสูง...");
    try {
      const dataUrl = await toPng(shareCardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        style: {
          transform: 'scale(1)',
          transformOrigin: 'top left',
          width: '540px',
          height: '960px'
        }
      });
      const link = document.createElement('a');
      link.download = `schedule-${blockName.replace(/\s+/g, '-')}.png`;
      link.href = dataUrl;
      link.click();
      setShareNotification("ดาวน์โหลดรูปภาพสำเร็จ!");
      setTimeout(() => setShareNotification(""), 3000);
    } catch (error) {
      console.error('Error generating image:', error);
      setShareNotification("เกิดข้อผิดพลาดในการสร้างรูปภาพ");
      setTimeout(() => setShareNotification(""), 3000);
    } finally {
      setIsGeneratingShare(false);
    }
  };

  const handleCopyShare = async () => {
    if (!shareCardRef.current) return;
    setIsGeneratingShare(true);
    setShareNotification("กำลังสร้างรูปภาพเพื่อคัดลอก...");
    try {
      const dataUrl = await toPng(shareCardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        style: {
          transform: 'scale(1)',
          transformOrigin: 'top left',
          width: '540px',
          height: '960px'
        }
      });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob
        })
      ]);
      setShareNotification("คัดลอกรูปภาพแล้ว! สามารถกด Paste (Ctrl+V / Cmd+V) ในแอป LINE หรือช่องแชทได้ทันที");
      setTimeout(() => setShareNotification(""), 4000);
    } catch (error) {
      console.error('Error copying image:', error);
      setShareNotification("ไม่สามารถคัดลอกได้อัตโนมัติ (กรุณาใช้ปุ่มดาวน์โหลดแทน)");
      setTimeout(() => setShareNotification(""), 3000);
    } finally {
      setIsGeneratingShare(false);
    }
  };

  const handleLoadBlock = async (id) => {
    setIsLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/blocks/${id}`);
      if (!res.ok) throw new Error("Failed to load block");

      const data = await res.json();
      setBlockName(data.name);
      setStartDate(data.start_date);
      setEndDate(data.end_date);
      setResidents(data.residents);
      setAssignments(data.assignments);
      
      // Trigger validation for stats and warnings
      handleValidate(data.assignments);
      setSuccessMsg(`Block '${data.name}' loaded successfully!`);
      setActiveTab("schedule");
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteBlock = async (id) => {
    if (!confirm("Are you sure you want to delete this block?")) return;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/blocks/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSuccessMsg("Block deleted successfully.");
        fetchBlocks();
      }
    } catch (e) {
      setErrorMsg("Failed to delete block");
    }
  };

  // Drag & Drop Handlers
  const handleDragStart = (residentName) => {
    setDraggedResident(residentName);
  };

  const handleDragOver = (e, dateStr, shiftName) => {
    e.preventDefault();
    setDragOverCell({ date: dateStr, shift: shiftName });
  };

  const handleDrop = (e, dateStr, shiftName) => {
    e.preventDefault();
    setDragOverCell(null);
    if (!draggedResident) return;

    // Check if cell is active
    const dayShifts = getActiveShiftsForDay(dateStr);
    if (!dayShifts.includes(shiftName)) return;

    // Update assignment
    const updated = assignments.map(a => {
      if (a.date === dateStr && a.shift_type === shiftName) {
        return { ...a, resident_name: draggedResident, is_locked: true };
      }
      return a;
    });

    // Check if assignment exists for this slot, if not create it
    const exists = assignments.some(a => a.date === dateStr && a.shift_type === shiftName);
    if (!exists) {
      // Find date weekday
      const d_val = new Date(dateStr);
      const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6 || !!holidays[dateStr];
      updated.push({
        date: dateStr,
        day_name: d_val.toLocaleDateString('en-US', { weekday: 'long' }),
        shift_type: shiftName,
        resident_name: draggedResident,
        is_locked: true,
        is_weekend: is_wk,
        hours: is_wk ? 24 : 16
      });
    }

    setAssignments(updated);
    setDraggedResident(null);
    handleValidate(updated);
  };

  const toggleLock = (dateStr, shiftName) => {
    const updated = assignments.map(a => {
      if (a.date === dateStr && a.shift_type === shiftName) {
        return { ...a, is_locked: !a.is_locked };
      }
      return a;
    });
    setAssignments(updated);
  };

  const clearAllLocks = () => {
    const updated = assignments.map(a => ({ ...a, is_locked: false }));
    setAssignments(updated);
    setSuccessMsg("All shift locks cleared.");
  };

  // Helper: generates date array
  const getDatesArray = () => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const arr = [];
    for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
      arr.push(new Date(dt).toISOString().split('T')[0]);
    }
    return arr;
  };

  const getActiveShiftsForDay = (dateStr) => {
    const d_val = new Date(dateStr);
    return shiftTypes.filter(s => {
      let active = true;
      if (s.active_from_date) {
        const from = new Date(s.active_from_date);
        if (d_val < from) active = false;
      }
      if (s.active_to_date) {
        const to = new Date(s.active_to_date);
        if (d_val > to) active = false;
      }
      return active;
    }).map(s => s.name);
  };

  // CSV I/O helpers
  const handleExportCSV = () => {
    if (assignments.length === 0) {
      alert("No assignments to export.");
      return;
    }
    const dates = getDatesArray();
    const headers = ["Date", "Day", ...shiftTypes.map(s => s.name)];
    
    const rows = dates.map(d_str => {
      const d_val = new Date(d_str);
      const dayName = d_val.toLocaleDateString('en-US', { weekday: 'short' });
      const row = [d_str, dayName];
      
      shiftTypes.forEach(s => {
        const active = getActiveShiftsForDay(d_str).includes(s.name);
        if (active) {
          const assign = assignments.find(a => a.date === d_str && a.shift_type === s.name);
          row.push(assign ? assign.resident_name : "");
        } else {
          row.push("N/A");
        }
      });
      return row;
    });

    const csvContent = "data:text/csv;charset=utf-8," 
      + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `schedule_${blockName.replace(/\s+/g, "_")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleImportCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target.result;
        const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) throw new Error("Empty CSV file");

        const headers = lines[0].split(",").map(h => h.trim());
        const shiftIndices = {};
        shiftTypes.forEach(s => {
          shiftIndices[s.name] = headers.indexOf(s.name);
        });

        const newAssigns = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map(c => c.trim());
          const dateStr = cols[0];
          const d_val = new Date(dateStr);
          if (isNaN(d_val.getTime())) continue;

          const day_name = d_val.toLocaleDateString('en-US', { weekday: 'long' });
          const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6 || !!holidays[dateStr];

          shiftTypes.forEach(s => {
            const idx = shiftIndices[s.name];
            if (idx !== undefined && idx !== -1 && cols[idx] && cols[idx] !== "N/A") {
              newAssigns.push({
                date: dateStr,
                day_name: day_name,
                shift_type: s.name,
                resident_name: cols[idx],
                is_locked: true,
                is_weekend: is_wk,
                hours: is_wk ? 24 : 16
              });
            }
          });
        }

        setAssignments(newAssigns);
        handleValidate(newAssigns);
        setSuccessMsg("Schedule CSV imported successfully!");
      } catch (err) {
        alert("Failed to parse CSV: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  // Helper to find cells with warnings
  const getCellViolations = (dateStr, shiftName) => {
    const assign = assignments.find(a => a.date === dateStr && a.shift_type === shiftName);
    if (!assign) return [];
    return violations.filter(v => v.date === dateStr && v.resident_name === assign.resident_name);
  };

  // Helpers for multi-date selection calendar modal
  const getMonthsInRange = () => {
    if (!startDate || !endDate) return [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    const months = [];
    
    let current = new Date(start.getFullYear(), start.getMonth(), 1);
    while (current <= end) {
      months.push({
        year: current.getFullYear(),
        month: current.getMonth() // 0-indexed
      });
      current.setMonth(current.getMonth() + 1);
    }
    return months;
  };

  const generateMonthDays = (year, month) => {
    const firstDayInstance = new Date(year, month, 1);
    const startDayOfWeek = firstDayInstance.getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];
    
    // Padding for start
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }
    
    // Days
    for (let d = 1; d <= totalDaysInMonth; d++) {
      const dateInstance = new Date(year, month, d);
      const yy = dateInstance.getFullYear();
      const mm = String(dateInstance.getMonth() + 1).padStart(2, '0');
      const dd = String(dateInstance.getDate()).padStart(2, '0');
      const dateStr = `${yy}-${mm}-${dd}`;
      
      const isWk = dateInstance.getDay() === 0 || dateInstance.getDay() === 6;
      const isInBlock = dateStr >= startDate && dateStr <= endDate;
      
      days.push({
        dateStr,
        dayNum: d,
        isWeekend: isWk,
        isHoliday: !!holidays[dateStr],
        isInBlock
      });
    }
    
    return days;
  };

  if (!user) {
    return (
      <div className="login-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-primary)' }}>
        <div className="login-card glass-panel animate-fade-in" style={{ padding: '40px', maxWidth: '400px', width: '100%', textAlign: 'center', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border-glass)' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: 'var(--accent-gradient)', color: '#fff', fontSize: '1.8rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px auto' }}>EW</div>
          <h2 style={{ fontSize: '1.5rem', marginBottom: '8px' }}>E-WANE</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>ระบบจัดเวรแพทย์ประจำบ้านแผนกอายุรศาสตร์</p>
          
          {errorMsg && <div className="alert-banner alert-error" style={{ margin: "16px 0", fontSize: '0.8rem' }}>{errorMsg}</div>}
          {successMsg && <div className="alert-banner alert-success" style={{ margin: "16px 0", fontSize: '0.8rem' }}>{successMsg}</div>}

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div id="google-signin-button" style={{ display: 'flex', justifyContent: 'center', width: '100%' }}></div>
            
            <div style={{ display: 'flex', alignItems: 'center', width: '100%', margin: '12px 0' }}>
              <hr style={{ flex: 1, border: '0', borderTop: '1px solid rgba(255,255,255,0.1)' }} />
              <span style={{ padding: '0 8px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>หรือ</span>
              <hr style={{ flex: 1, border: '0', borderTop: '1px solid rgba(255,255,255,0.1)' }} />
            </div>
            
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={handleBypassLogin}>
              Bypass Login (Admin Bypass)
            </button>
            <button className="btn btn-secondary" style={{ width: '100%' }} onClick={handleBypassResidentLogin}>
              Bypass Login (Resident Bypass)
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user.is_admin && !user.resident_name) {
    return (
      <div className="login-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg-primary)' }}>
        <div className="login-card glass-panel animate-fade-in" style={{ padding: '32px', maxWidth: '480px', width: '100%' }}>
          <h2>เชื่อมต่อประวัติแพทย์ประจำบ้าน</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '20px', marginTop: '8px' }}>
            บัญชี Google ({user.email}) ของท่านยังไม่ได้เชื่อมโยงกับรายชื่อแพทย์ในระบบ กรุณาเลือกชื่อของท่านเพื่อยืนยันประวัติ
          </p>

          {errorMsg && <div className="alert-banner alert-error" style={{ margin: "16px 0" }}>{errorMsg}</div>}
          
          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label style={{ fontSize: '0.85rem' }}>เลือกชื่อแพทย์ประจำบ้านของท่าน</label>
            <select 
              className="input-select" 
              id="mapping-name-select"
              defaultValue=""
              style={{ width: '100%', marginTop: '8px' }}
            >
              <option value="" disabled>-- กรุณาเลือกชื่อของท่าน --</option>
              {SEEDED_RESIDENTS.map(r => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleLogout}>
              Logout
            </button>
            <button 
              className="btn btn-primary" 
              style={{ flex: 1 }}
              onClick={() => {
                const name = document.getElementById("mapping-name-select").value;
                if (!name) {
                  setErrorMsg("กรุณาเลือกชื่อของท่าน");
                } else {
                  handleMapProfile(name);
                }
              }}
            >
              เชื่อมต่อบัญชี (Link)
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user.is_admin) {
    return (
      <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {/* Resident Portal Header */}
        <div className="resident-header glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px', padding: '16px 24px', borderRadius: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {user.picture ? (
              <img src={user.picture} alt="Profile" style={{ width: '48px', height: '48px', borderRadius: '50%' }} />
            ) : (
              <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--accent-gradient)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                {user.resident_name ? user.resident_name[0] : 'R'}
              </div>
            )}
            <div>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>นพ./พญ. {user.resident_name} (E-WANE Resident Portal)</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
                {user.email} | สถานะการเชื่อมโยง: เรียบร้อย
              </p>
            </div>
          </div>
          <button className="btn btn-secondary" onClick={handleLogout}>
            Logout
          </button>
        </div>

        {/* Resident Portal Body */}
        <div style={{ flex: 1, padding: '0 20px 20px 20px', display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: '20px', minHeight: 0 }}>
          {/* Left panel: details and calendar sync */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', overflowY: 'auto' }}>
            
            {/* Banner messages */}
            {successMsg && (
              <div className="alert-banner alert-success" style={{ margin: 0 }}>
                <span>{successMsg}</span>
                <button className="btn-icon" onClick={() => setSuccessMsg("")} style={{ color: 'inherit' }}>
                  <X size={16} />
                </button>
              </div>
            )}
            {errorMsg && (
              <div className="alert-banner alert-error" style={{ margin: 0 }}>
                <span>{errorMsg}</span>
                <button className="btn-icon" onClick={() => setErrorMsg("")} style={{ color: 'inherit' }}>
                  <X size={16} />
                </button>
              </div>
            )}

            {/* Ward Rotation Details */}
            <div className="glass-panel panel-card" style={{ padding: '20px' }}>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>วอร์ดปัจจุบัน & ข้อมูลคลินิก OPD (Current Rotation)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>วอร์ดหมุนเวียน (Rotation)</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: 'var(--accent-secondary)', marginTop: '4px' }}>
                    {residentProfile?.rotation || "กำลังโหลด..."}
                  </div>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>วันคลินิก OPD (คงที่)</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold', marginTop: '4px' }}>
                    {residentProfile?.opd_days && residentProfile.opd_days.length > 0 
                      ? residentProfile.opd_days.join(", ") 
                      : "ไม่มี"}
                  </div>
                </div>
              </div>
            </div>

            {/* Calendar Subscription Sync Link */}
            {user.ical_token && (
              <div className="glass-panel panel-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: '1.1rem', marginBottom: '8px' }}>ลิงก์สำหรับซิงค์ปฏิทินส่วนตัว (Google Calendar Sync)</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  คัดลอกลิงก์ด้านล่างไปเพิ่มลงใน Google Calendar / Apple Calendar ของคุณ เพื่อติดตามตารางเวรแบบออโต้ (100% ฟรี ไม่มีค่าใช้จ่าย)
                </p>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <input 
                    type="text" 
                    className="input-text" 
                    readOnly 
                    value={getAbsoluteCalendarUrl(user.ical_token)} 
                    style={{ flex: 1, fontSize: '0.8rem', fontFamily: 'monospace' }}
                    onClick={(e) => e.target.select()}
                  />
                  <button 
                    className="btn btn-primary"
                    onClick={() => {
                      navigator.clipboard.writeText(getAbsoluteCalendarUrl(user.ical_token));
                      setSuccessMsg("คัดลอกลิงก์ซิงค์ไปยังคลิปบอร์ดแล้ว!");
                    }}
                  >
                    คัดลอกลิงก์
                  </button>
                </div>
                <div style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '12px', padding: '12px', fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                  <h4 style={{ color: 'var(--text-primary)', marginBottom: '4px', fontSize: '0.8rem' }}>วิธีซิงค์ลงในปฏิทิน Google Calendar:</h4>
                  1. เข้าปฏิทินของท่านทางคอมพิวเตอร์ (Google Calendar Web) <br />
                  2. เมนูด้านซ้ายล่าง มองหา <strong>"ปฏิทินอื่น" (Other calendars)</strong> กดปุ่ม <strong>+</strong> <br />
                  3. เลือก <strong>"จาก URL" (From URL)</strong> แล้ววางลิงก์ที่ก๊อปปี้ไป กดบันทึกปฏิทิน
                </div>
              </div>
            )}

            {/* Shifts assigned to this resident */}
            <div className="glass-panel panel-card" style={{ padding: '20px', flex: 1, minHeight: '200px', display: 'flex', flexDirection: 'column' }}>
              <h3 style={{ fontSize: '1.1rem', marginBottom: '12px' }}>เวรปฏิบัติงานของคุณประจำรอบนี้</h3>
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <table className="schedule-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>วันที่ (Date)</th>
                      <th>วัน (Day)</th>
                      <th>ประเภทเวรที่ได้รับมอบหมาย (Shift Duty)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {residentProfile?.assignments && residentProfile.assignments.length > 0 ? (
                      residentProfile.assignments.map((a, idx) => (
                        <tr key={idx}>
                          <td>{a.date}</td>
                          <td>{a.day_name}</td>
                          <td>
                            <span style={{ background: 'var(--accent-gradient)', padding: '4px 8px', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                              {a.shift_type}
                            </span>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="3" style={{ textAlign: 'center', opacity: 0.5, padding: '24px' }}>
                          ยังไม่พบตารางจัดเวรของท่านสำหรับรอบนี้
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Right panel: Blocked dates calendar */}
          <div className="glass-panel panel-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <h3 style={{ fontSize: '1.1rem', margin: 0 }}>ส่งคำขอวันลา / บล็อกเวรล่วงหน้า</h3>
              <span style={{ fontSize: '0.8rem', background: 'var(--accent-gradient)', padding: '2px 8px', borderRadius: '12px', fontWeight: 'bold' }}>
                เลือกแล้ว {residentBlockedDatesDraft.length} วัน
              </span>
            </div>

            {false ? (
              <div className="alert-banner alert-error" style={{ margin: '0 0 12px 0', fontSize: '0.8rem', padding: '10px 12px' }}>
                <span>⚠️ ระบบปิดรับการแก้ไขวันลาแล้ว (ทุกวันที่ 20 ของเดือน)</span>
              </div>
            ) : (
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '12px', lineHeight: '1.3' }}>
                คลิกเลือกวันที่ต้องการหลีกเลี่ยงการจัดเวรโดยตรงบนปฏิทินด้านล่าง (ระบบล็อกการแก้ไขทุกวันที่ 20 - ขณะนี้เปิดให้ทดสอบ)
              </p>
            )}

            <div className="resident-calendar-container" style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
              {getMonthsInRange().map(({ year, month }) => {
                const days = generateMonthDays(year, month);
                const monthLabel = new Date(year, month, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
                const isLocked = false; // Disabled temporarily for testing

                return (
                  <div key={`${year}-${month}`} className="calendar-month-section" style={{ marginBottom: '20px' }}>
                    <div className="calendar-month-title" style={{ fontSize: '0.9rem', marginBottom: '8px', color: 'var(--accent-primary)', fontWeight: '600' }}>
                      {monthLabel}
                    </div>
                    <div className="calendar-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '6px' }}>
                      {/* Week headers */}
                      {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map(h => (
                        <div key={h} className="calendar-header-day" style={{ textAlign: 'center', fontSize: '0.7rem', fontWeight: '600', color: 'var(--text-muted)' }}>{h}</div>
                      ))}

                      {/* Calendar days */}
                      {days.map((day, dIdx) => {
                        if (!day) return <div key={`empty-${dIdx}`} className="calendar-day-empty" style={{ visibility: 'hidden' }} />;
                        
                        const isBlocked = residentBlockedDatesDraft.includes(day.dateStr);
                        
                        return (
                          <button
                            key={day.dateStr}
                            className={`calendar-day-btn ${day.isWeekend ? 'weekend' : ''} ${day.isHoliday ? 'holiday' : ''} ${isBlocked ? 'blocked' : ''} ${!day.isInBlock ? 'inactive' : ''}`}
                            disabled={isLocked || !day.isInBlock}
                            onClick={() => {
                              if (isLocked) return;
                              if (isBlocked) {
                                setResidentBlockedDatesDraft(prev => prev.filter(d => d !== day.dateStr));
                              } else {
                                setResidentBlockedDatesDraft(prev => [...prev, day.dateStr].sort());
                              }
                            }}
                            style={{
                              padding: '10px 0',
                              borderRadius: '8px',
                              border: '1px solid var(--border-glass)',
                              background: isBlocked ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.02)',
                              color: isBlocked ? '#fca5a5' : (day.isWeekend ? 'var(--color-warning)' : 'var(--text-primary)'),
                              fontSize: '0.8rem',
                              cursor: (isLocked || !day.isInBlock) ? 'not-allowed' : 'pointer',
                              opacity: day.isInBlock ? (isLocked ? 0.7 : 1) : 0.25,
                              fontWeight: isBlocked ? '600' : 'normal',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              transition: 'all var(--transition-fast)'
                            }}
                          >
                            {day.dayNum}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Submit changes warning & button */}
            {JSON.stringify([...residentBlockedDates].sort()) !== JSON.stringify([...residentBlockedDatesDraft].sort()) && (
              <div style={{ fontSize: '0.75rem', color: 'var(--color-warning)', marginTop: '8px', textAlign: 'center', fontWeight: '500' }}>
                ⚠️ คุณมีการแก้ไขวันลาที่ยังไม่ได้กดบันทึก
              </div>
            )}
            <div style={{ marginTop: '12px' }}>
              <button 
                className="btn btn-primary"
                style={{ width: '100%', padding: '12px 16px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
                disabled={isLoading}
                onClick={handleSyncBlockedDates}
              >
                <Save size={16} /> บันทึกข้อมูลวันลา (Save Vacation Requests)
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const renderStatsView = () => {
    if (statsLoading) {
      return (
        <div className="glass-panel" style={{ padding: '60px', textAlign: 'center', marginTop: '24px' }}>
          <RefreshCw className="animate-spin" size={48} style={{ marginBottom: '16px', color: 'var(--accent-primary)', display: 'inline-block' }} />
          <p>กำลังคำนวณและประมวลผลข้อมูลเปรียบเทียบ...</p>
        </div>
      );
    }

    if (!statsData || !statsData.residents || statsData.residents.length === 0) {
      return (
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', marginTop: '24px' }}>
          <BarChart2 size={48} style={{ marginBottom: '16px', opacity: 0.3, color: 'var(--accent-primary)', display: 'inline-block' }} />
          <p>ไม่พบข้อมูลการจัดเวรในระบบเพื่อเปรียบเทียบ (กรุณาสร้างและบันทึกตารางจัดเวรอย่างน้อย 1 รอบก่อน)</p>
          <button className="btn btn-primary" onClick={fetchStatsComparison} style={{ marginTop: '16px' }}>
            <RefreshCw size={14} style={{ marginRight: '6px' }} /> ดึงข้อมูลใหม่
          </button>
        </div>
      );
    }

    const isCumulative = statsSelectedBlock === "cumulative";
    const selectedStats = isCumulative 
      ? statsData.cumulative 
      : (statsData.blocks.find(b => b.id.toString() === statsSelectedBlock)?.stats || {});

    const activeResidents = statsData.residents.filter(r => selectedStats[r]);

    if (activeResidents.length === 0) {
      return (
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', marginTop: '24px' }}>
          <p>ไม่มีข้อมูลสถิติสำหรับรอบจัดเวรที่เลือก</p>
        </div>
      );
    }

    let totalHoursSum = 0;
    let maxHours = -1;
    let minHours = 999999;
    let maxResident = "";
    let minResident = "";
    let totalWeekdayShifts = 0;
    let totalWeekendShifts = 0;
    let maxShifts = 1;

    activeResidents.forEach(res => {
      const rStats = selectedStats[res];
      if (rStats) {
        totalHoursSum += rStats.total_hours;
        totalWeekdayShifts += rStats.weekday_count;
        totalWeekendShifts += rStats.weekend_count;
        const shiftsTotal = rStats.weekday_count + rStats.weekend_count;
        if (shiftsTotal > maxShifts) {
          maxShifts = shiftsTotal;
        }

        if (rStats.total_hours > maxHours) {
          maxHours = rStats.total_hours;
          maxResident = res;
        }
        if (rStats.total_hours < minHours) {
          minHours = rStats.total_hours;
          minResident = res;
        }
      }
    });

    const avgHours = activeResidents.length > 0 ? (totalHoursSum / activeResidents.length).toFixed(1) : 0;

    const sortedResidentsList = [...activeResidents].sort((a, b) => {
      let valA = 0;
      let valB = 0;

      const rStatsA = selectedStats[a];
      const rStatsB = selectedStats[b];

      if (statsSortField === "name") {
        valA = a;
        valB = b;
      } else if (statsSortField === "weekday") {
        valA = rStatsA ? rStatsA.weekday_count : 0;
        valB = rStatsB ? rStatsB.weekday_count : 0;
      } else if (statsSortField === "weekend") {
        valA = rStatsA ? rStatsA.weekend_count : 0;
        valB = rStatsB ? rStatsB.weekend_count : 0;
      } else if (statsSortField === "total_shifts") {
        valA = rStatsA ? rStatsA.total_count : 0;
        valB = rStatsB ? rStatsB.total_count : 0;
      } else if (statsSortField === "total_hours") {
        valA = rStatsA ? rStatsA.total_hours : 0;
        valB = rStatsB ? rStatsB.total_hours : 0;
      } else if (statsData.shift_types.includes(statsSortField)) {
        valA = rStatsA ? (rStatsA.shift_counts[statsSortField] || 0) : 0;
        valB = rStatsB ? (rStatsB.shift_counts[statsSortField] || 0) : 0;
      }

      if (typeof valA === "string") {
        return statsSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      } else {
        return statsSortAsc ? valA - valB : valB - valA;
      }
    });

    const handleSort = (field) => {
      if (statsSortField === field) {
        setStatsSortAsc(!statsSortAsc);
      } else {
        setStatsSortField(field);
        setStatsSortAsc(false);
      }
    };

    const renderSortIndicator = (field) => {
      if (statsSortField !== field) return null;
      return (
        <span className="sort-indicator">
          {statsSortAsc ? "▲" : "▼"}
        </span>
      );
    };

    return (
      <div className="animate-fade-in">
        <div className="page-header">
          <div>
            <h2>วิเคราะห์ภาระงานและเปรียบเทียบข้อมูล (Workload Analytics)</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
              เปรียบเทียบชั่วโมงทำงาน สัดส่วนเวรวันธรรมดา/วันหยุด และประเภทเวรสำหรับแพทย์แต่ละท่าน
            </p>
          </div>
          <div className="header-actions">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>เลือกรอบจัดเวร:</label>
              <select 
                className="input-select" 
                value={statsSelectedBlock} 
                onChange={(e) => setStatsSelectedBlock(e.target.value)}
                style={{ minWidth: '220px' }}
              >
                <option value="cumulative">สะสมทุกรอบการจัดเวร (Cumulative)</option>
                {statsData.blocks.map(b => (
                  <option key={b.id} value={b.id.toString()}>{b.name}</option>
                ))}
              </select>
              <button className="btn btn-secondary" onClick={fetchStatsComparison} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <RefreshCw size={14} /> โหลดใหม่
              </button>
            </div>
          </div>
        </div>

        <div className="metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
          <div className="glass-panel metric-card" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>ชั่วโมงภาระงานรวมทั้งหมด</span>
            <span style={{ fontSize: '1.8rem', fontWeight: 'bold', background: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              {totalHoursSum} ชม.
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>รวมแพทย์ทั้งหมด {activeResidents.length} คน</span>
          </div>
          <div className="glass-panel metric-card" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>ชั่วโมงทำงานเฉลี่ยต่อคน</span>
            <span style={{ fontSize: '1.8rem', fontWeight: 'bold', color: 'var(--color-info)' }}>
              {avgHours} ชม.
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>เฉลี่ยทุกคนในรอบที่เลือก</span>
          </div>
          <div className="glass-panel metric-card" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>ภาระงานสูงสุด (Max Workload)</span>
            <span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: 'var(--color-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${maxResident}: ${maxHours} ชม.`}>
              {maxResident} ({maxHours} ชม.)
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>ชั่วโมงเวรสูงสุดในระบบ</span>
          </div>
          <div className="glass-panel metric-card" style={{ padding: '20px', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>ภาระงานต่ำสุด (Min Workload)</span>
            <span style={{ fontSize: '1.3rem', fontWeight: 'bold', color: 'var(--color-success)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${minResident}: ${minHours} ชม.`}>
              {minResident} ({minHours} ชม.)
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>ชั่วโมงเวรต่ำสุดในระบบ</span>
          </div>
        </div>

        <div className="analytics-dashboard-grid">
          <div className="glass-panel table-panel" style={{ padding: '24px' }}>
            <div className="table-header-bar" style={{ marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>ตารางเปรียบเทียบภาระงานรายบุคคล (Side-by-Side Comparison)</h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
                คลิกที่หัวตารางเพื่อจัดเรียงข้อมูล
              </p>
            </div>
            
            <div className="table-container" style={{ overflowX: 'auto' }}>
              <table className="schedule-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: '60px' }}>ลำดับ</th>
                    <th className="stats-header-sortable" onClick={() => handleSort("name")}>
                      แพทย์ {renderSortIndicator("name")}
                    </th>
                    {statsData.shift_types.map(st => (
                      <th key={st} className="stats-header-sortable" onClick={() => handleSort(st)}>
                        {st} {renderSortIndicator(st)}
                      </th>
                    ))}
                    <th className="stats-header-sortable" onClick={() => handleSort("weekday")}>
                      เวรวันธรรมดา {renderSortIndicator("weekday")}
                    </th>
                    <th className="stats-header-sortable" onClick={() => handleSort("weekend")}>
                      เวรวันหยุด {renderSortIndicator("weekend")}
                    </th>
                    <th className="stats-header-sortable" onClick={() => handleSort("total_shifts")}>
                      รวมเวร {renderSortIndicator("total_shifts")}
                    </th>
                    <th className="stats-header-sortable" onClick={() => handleSort("total_hours")}>
                      รวมชั่วโมง {renderSortIndicator("total_hours")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResidentsList.map((res, index) => {
                    const rStats = selectedStats[res];
                    if (!rStats) return null;
                    const hoursLow = rStats.total_hours < 80 && !isCumulative;
                    return (
                      <tr key={res} className="stats-table-row">
                        <td style={{ textAlign: 'center', opacity: 0.6 }}>{index + 1}</td>
                        <td style={{ fontWeight: 'bold' }}>{res}</td>
                        {statsData.shift_types.map(st => {
                          const count = rStats.shift_counts[st] || 0;
                          const hours = rStats.shift_hours[st] || 0;
                          return (
                            <td key={st} style={{ textAlign: 'center' }} className={count === 0 ? "cell-zero-value" : ""}>
                              {count > 0 ? `${count} (${hours}ชม)` : "-"}
                            </td>
                          );
                        })}
                        <td style={{ textAlign: 'center' }} className={rStats.weekday_count === 0 ? "cell-zero-value" : ""}>
                          {rStats.weekday_count > 0 ? `${rStats.weekday_count} (${rStats.weekday_hours}ชม)` : "-"}
                        </td>
                        <td style={{ textAlign: 'center' }} className={rStats.weekend_count === 0 ? "cell-zero-value" : ""}>
                          {rStats.weekend_count > 0 ? `${rStats.weekend_count} (${rStats.weekend_hours}ชม)` : "-"}
                        </td>
                        <td style={{ textAlign: 'center', fontWeight: '500' }}>{rStats.total_count}</td>
                        <td style={{ textAlign: 'center', fontWeight: 'bold' }}>
                          <span style={{ color: hoursLow ? 'var(--color-danger)' : 'var(--text-primary)' }}>
                            {rStats.total_hours} ชม.
                          </span>
                          {hoursLow && (
                            <span style={{ fontSize: '0.65rem', display: 'block', color: 'var(--color-danger)', fontWeight: 'normal' }}>
                              (ต่ำกว่า 80 ชม.)
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="charts-section-grid">
            <div className="glass-panel chart-card">
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontFamily: 'var(--font-title)' }}>
                ชั่วโมงทำงานสะสม (Total Duty Hours)
              </h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                เปรียบเทียบชั่วโมงทำงานรวมทั้งหมด (เรียงตามลำดับชั่วโมงสูงสุด)
              </p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                {[...activeResidents]
                  .sort((a, b) => (selectedStats[b]?.total_hours || 0) - (selectedStats[a]?.total_hours || 0))
                  .map(res => {
                    const rStats = selectedStats[res];
                    if (!rStats) return null;
                    const percent = Math.min(100, Math.max(5, (rStats.total_hours / (maxHours || 1)) * 100));
                    return (
                      <div key={res} className="chart-bar-row">
                        <div className="chart-bar-label">{res}</div>
                        <div className="chart-bar-container">
                          <div className="chart-bar-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <div className="chart-bar-value">{rStats.total_hours} ชม.</div>
                      </div>
                    );
                  })}
              </div>
            </div>

            <div className="glass-panel chart-card">
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontFamily: 'var(--font-title)' }}>
                จำนวนครั้งที่ขึ้นเวร วันธรรมดา vs วันหยุด
              </h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                เปรียบเทียบความถี่การปฏิบัติงานวันธรรมดากับวันเสาร์-อาทิตย์และวันหยุดนักขัตฤกษ์
              </p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                {[...activeResidents]
                  .sort((a, b) => {
                    const totalA = (selectedStats[a]?.weekday_count || 0) + (selectedStats[a]?.weekend_count || 0);
                    const totalB = (selectedStats[b]?.weekday_count || 0) + (selectedStats[b]?.weekend_count || 0);
                    return totalB - totalA;
                  })
                  .map(res => {
                    const rStats = selectedStats[res];
                    if (!rStats) return null;
                    const totalShifts = rStats.weekday_count + rStats.weekend_count;
                    const weekdayPercent = Math.max(0, (rStats.weekday_count / (maxShifts || 1)) * 100);
                    const weekendPercent = Math.max(0, (rStats.weekend_count / (maxShifts || 1)) * 100);
                    
                    return (
                      <div key={res} className="chart-bar-row">
                        <div className="chart-bar-label">{res}</div>
                        <div className="chart-bar-container">
                          <div className="chart-bar-fill-weekday" style={{ width: `${weekdayPercent}%` }} />
                          <div className="chart-bar-fill-weekend" style={{ width: `${weekendPercent}%` }} />
                        </div>
                        <div className="chart-bar-value" style={{ fontSize: '0.72rem' }}>
                          {rStats.weekday_count} จ-ศ / {rStats.weekend_count} ส-อา ({totalShifts} เวร)
                        </div>
                      </div>
                    );
                  })}
              </div>

              <div className="chart-legend">
                <div className="chart-legend-item">
                  <div className="chart-legend-color" style={{ background: 'rgba(99, 102, 241, 0.85)' }} />
                  <span>เวรวันธรรมดา (Weekday - 16 ชม.)</span>
                </div>
                <div className="chart-legend-item">
                  <div className="chart-legend-color" style={{ background: 'rgba(245, 158, 11, 0.85)' }} />
                  <span>เวรวันหยุด (Weekend/Holiday - 24 ชม.)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app-container">
      {/* Navigation Sidebar */}
      <div className="sidebar">
        <div className="logo-container">
          <div className="logo-icon">EW</div>
          <div className="logo-text">
            <h1>E-WANE</h1>
            <p>Resident Shift Scheduler</p>
          </div>
        </div>

        <div className="nav-links">
          <div 
            className={`nav-item ${activeTab === 'schedule' ? 'active' : ''}`}
            onClick={() => setActiveTab("schedule")}
          >
            <Calendar size={18} />
            ตารางจัดเวร (Schedule)
          </div>
          <div 
            className={`nav-item ${activeTab === 'residents' ? 'active' : ''}`}
            onClick={() => setActiveTab("residents")}
          >
            <Users size={18} />
            จัดการแพทย์ (Residents)
          </div>
          <div 
            className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab("settings")}
          >
            <SettingsIcon size={18} />
            ตั้งค่าระบบ (Settings)
          </div>
          <div 
            className={`nav-item ${activeTab === 'db' ? 'active' : ''}`}
            onClick={() => { setActiveTab("db"); fetchBlocks(); }}
          >
            <Database size={18} />
            ประวัติจัดเวร (Saved Blocks)
          </div>
          <div 
            className={`nav-item ${activeTab === 'stats' ? 'active' : ''}`}
            onClick={() => { setActiveTab("stats"); fetchStatsComparison(); }}
          >
            <BarChart2 size={18} />
            สถิติและเปรียบเทียบ (Analytics)
          </div>
        </div>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
            {user.picture ? (
              <img src={user.picture} alt="Admin" style={{ width: '32px', height: '32px', borderRadius: '50%' }} />
            ) : (
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 'bold' }}>A</div>
            )}
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>{user.name}</div>
              <div style={{ fontSize: '0.65rem', opacity: 0.6 }}>ผู้ดูแลระบบ (Admin)</div>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem', marginBottom: '12px' }} onClick={handleLogout}>
            ลงชื่อออก (Logout)
          </button>
          <p>Version 1.0 (Auth + Sync)</p>
        </div>
      </div>

      {/* Main Panel Content */}
      <div className="main-content">
        {/* Banner messages */}
        {successMsg && (
          <div className="alert-banner alert-success">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Info size={16} />
              <span>{successMsg}</span>
            </div>
            <button className="btn-icon" onClick={() => setSuccessMsg("")} style={{ color: 'inherit' }}>
              <X size={16} />
            </button>
          </div>
        )}

        {errorMsg && (
          <div className="alert-banner alert-error">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertTriangle size={16} />
              <span>{errorMsg}</span>
            </div>
            <button className="btn-icon" onClick={() => setErrorMsg("")} style={{ color: 'inherit' }}>
              <X size={16} />
            </button>
          </div>
        )}

        {/* ========================================================
            TAB: SCHEDULE
            ======================================================== */}
        {activeTab === "schedule" && (
          <div className="animate-fade-in">
            <div className="page-header">
              <div className="block-title-area">
                <h2>{blockName || "ตารางจัดเวร"}</h2>
                <div className="block-info-sub">
                  <span>ช่วงเวลา: {startDate} ถึง {endDate}</span>
                  <span>จำนวน residents: {residents.length} คน</span>
                </div>
              </div>
              <div className="header-actions">
                <button className="btn btn-secondary" onClick={clearAllLocks}>
                  เคลียร์ตัวล็อค (Clear Locks)
                </button>
                <button className="btn btn-secondary" onClick={handleSaveBlock}>
                  <Save size={16} /> บันทึกลงฐานข้อมูล
                </button>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => setShowShareModal(true)} 
                  disabled={assignments.length === 0}
                  title={assignments.length === 0 ? "กรุณากดคำนวณเวรก่อนแชร์" : ""}
                >
                  <Share2 size={16} /> แชร์ตารางเวร (Share)
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={handleGenerate} 
                  disabled={isLoading}
                >
                  {isLoading ? <RefreshCw className="animate-spin" size={16} /> : <Play size={16} />}
                  คำนวณเวรอัตโนมัติ (Generate)
                </button>
              </div>
            </div>

            <div className="schedule-layout">
              {/* Left Column: Calendar Sheet */}
              <div className="glass-panel table-panel">
                <div className="table-header-bar">
                  <h3>ตารางเวรประจำรอบการหมุนเวียน (Rotation Block Sheet)</h3>
                  <div className="legend">
                    <div className="legend-item">
                      <div className="legend-color legend-weekend"></div>
                      <span>วันเสาร์-อาทิตย์</span>
                    </div>
                    <div className="legend-item">
                      <div className="legend-color legend-holiday"></div>
                      <span>วันหยุดราชการ</span>
                    </div>
                    <div className="legend-item">
                      <div className="legend-color legend-locked"></div>
                      <span>เวรที่ถูกล็อกไว้</span>
                    </div>
                  </div>
                </div>

                <div className="table-container">
                  <table className="schedule-table">
                    <thead>
                      <tr>
                        <th style={{ width: '120px' }}>วันที่ (Date)</th>
                        <th style={{ width: '100px' }}>วัน (Day)</th>
                        {shiftTypes.map(s => (
                          <th key={s.name}>{s.display_name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {getDatesArray().map(d_str => {
                        const d_val = new Date(d_str);
                        const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6;
                        const is_hol = !!holidays[d_str];
                        let rowClass = "";
                        if (is_hol) rowClass = "row-holiday";
                        else if (is_wk) rowClass = "row-weekend";

                        const activeShifts = getActiveShiftsForDay(d_str);

                        return (
                          <tr key={d_str} className={rowClass}>
                            <td>{d_str}</td>
                            <td title={is_hol ? holidays[d_str] : ""}>
                              {d_val.toLocaleDateString('en-US', { weekday: 'short' })}
                              {is_hol && <span className="holiday-tag" title={holidays[d_str]}>HOL</span>}
                            </td>
                            {shiftTypes.map(s => {
                              const isActive = activeShifts.includes(s.name);
                              const assign = assignments.find(a => a.date === d_str && a.shift_type === s.name);
                              const cellViolations = getCellViolations(d_str, s.name);
                              const hasViolation = cellViolations.length > 0;
                              
                              const cellKey = `${d_str}-${s.name}`;
                              const isOver = dragOverCell?.date === d_str && dragOverCell?.shift === s.name;

                              return (
                                <td 
                                  key={s.name}
                                  className={`shift-cell ${isOver ? 'drag-over' : ''} ${!isActive ? 'cell-inactive' : ''}`}
                                  onDragOver={(e) => isActive && handleDragOver(e, d_str, s.name)}
                                  onDrop={(e) => isActive && handleDrop(e, d_str, s.name)}
                                >
                                  {isActive ? (
                                    assign ? (
                                      <div 
                                        className={`shift-card ${assign.is_locked ? 'locked' : ''} ${hasViolation ? 'has-error' : ''}`}
                                        draggable
                                        onDragStart={() => handleDragStart(assign.resident_name)}
                                      >
                                        <span>{assign.resident_name}</span>
                                        <div className="cell-actions">
                                          {hasViolation && (
                                            <div className="warning-indicator tooltip">
                                              <AlertTriangle size={14} />
                                              <span className="tooltip-text">
                                                {cellViolations.map((v, i) => (
                                                  <div key={i} style={{ textAlign: 'left', marginBottom: '4px' }}>
                                                    • {v.rule}: {v.details}
                                                  </div>
                                                ))}
                                              </span>
                                            </div>
                                          )}
                                          <button 
                                            className={`btn-icon ${assign.is_locked ? 'active' : ''}`}
                                            onClick={() => toggleLock(d_str, s.name)}
                                            title={assign.is_locked ? "Unlock Shift" : "Lock Shift (Fix this doctor)"}
                                          >
                                            {assign.is_locked ? <Lock size={12} /> : <Unlock size={12} />}
                                          </button>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="shift-card-empty" style={{ opacity: 0.4, border: '1px dashed rgba(255,255,255,0.1)', padding: '8px', textAlign: 'center', fontSize: '0.75rem', borderRadius: '8px' }}>
                                        ลากชื่อใส่ที่นี่
                                      </div>
                                    )
                                  ) : (
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                                      ปิดเวร (N/A)
                                    </div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Column: Information panel */}
              <div className="side-panel">
                {/* 1. Draggable Resident List */}
                <div className="glass-panel panel-card">
                  <h3>จัดสรรแพทย์ (Residents List)</h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    ลากชื่อแพทย์ด้านล่างนี้ ไปวางในช่องตารางเวรเพื่อสลับ/เปลี่ยนเวรด้วยมือได้ทันที
                  </p>
                  <div className="draggable-residents-list">
                    {residents.map(r => (
                      <div 
                        key={r.name}
                        className="draggable-resident-item"
                        draggable
                        onDragStart={() => handleDragStart(r.name)}
                      >
                        {r.name}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 2. Violations Check */}
                <div className="glass-panel panel-card">
                  <h3>การละเมิดเงื่อนไข ({violations.length})</h3>
                  <div className="violations-list">
                    {violations.length === 0 ? (
                      <div style={{ color: 'var(--color-success)', fontSize: '0.85rem', textAlign: 'center', padding: '16px' }}>
                        ✓ ไม่พบการละเมิดเงื่อนไขใดๆ จัดเวรเสร็จสมบูรณ์
                      </div>
                    ) : (
                      violations.map((v, idx) => (
                        <div key={idx} className={`violation-item violation-${v.type}`}>
                          <div className="violation-title">
                            <span>{v.rule}</span>
                            {v.date && <span className="violation-date">{v.date}</span>}
                          </div>
                          <div>แพทย์: {v.resident_name}</div>
                          <div style={{ opacity: 0.95, fontSize: '0.75rem', marginTop: '2px' }}>{v.details}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* 3. Resident Hours Statistics */}
                <div className="glass-panel panel-card">
                  <h3>สถิติจำนวนชั่วโมงปฏิบัติงาน</h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    เกณฑ์ขั้นต่ำ: 80 ชั่วโมงทุกคน (วันธรรมดา = 16ชม, วันหยุด = 24ชม)
                  </p>
                  <div className="stats-list">
                    {residentStats.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: '16px' }}>
                        สถิติจะแสดงหลังจากมีตารางเวร
                      </div>
                    ) : (
                      residentStats.map(stat => {
                        const isUnder = stat.total_hours < 80;
                        return (
                          <div key={stat.name} className={`stat-item ${isUnder ? 'has-violation' : ''}`}>
                            <div className="stat-item-left">
                              <span className="stat-name">{stat.name}</span>
                              <span className="stat-rotation">
                                Rot: {stat.rotation} | WE: {stat.weekend_hours}ชม
                              </span>
                            </div>
                            <span className={`stat-hours ${isUnder ? 'warning' : ''}`}>
                              {stat.total_hours} ชม.
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            TAB: RESIDENTS PROFILE
            ======================================================== */}
        {activeTab === "residents" && (
          <div className="animate-fade-in">
            <div className="page-header">
              <div>
                <h2>จัดการข้อมูลแพทย์ (IM Resident Settings)</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
                  แก้ไขวอร์ดหมุนเวียน (Rotations), วันทำคลินิก OPD, และวันหยุดลาพักร้อน (Vacation block)
                </p>
              </div>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button 
                  className="btn btn-secondary"
                  onClick={() => syncRotationsWithCSV(blockName)}
                  style={{ gap: '6px' }}
                >
                  <RefreshCw size={14} /> โหลดวอร์ดหมุนเวียนจากไฟล์ (Sync CSV)
                </button>
              </div>
            </div>

            <div className="glass-panel" style={{ padding: '12px 20px', marginBottom: '20px', borderRadius: '12px', borderLeft: '3px solid var(--accent-primary)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
              <Info size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <span>
                ข้อมูลวอร์ดหมุนเวียนและวัน OPD ถูกกำหนดผ่านไฟล์ <strong>rotations.csv</strong> และ <strong>opd.csv</strong> เพื่อป้องกันความผิดพลาดจึงปิดการแก้ไขจากหน้านี้ [ แก้ไขข้อมูลวันหยุด/วันลาของแพทย์ผ่านปฏิทินได้ตลอดเวลา ]
              </span>
            </div>

            <div className="residents-grid">
              {residents.map((r, rIdx) => {
                const isEditing = editingResident === r.name;
                return (
                  <div key={r.name} className="glass-panel resident-card">
                    <div className="resident-card-header">
                      <span className="resident-card-name">{r.name}</span>
                      <span className="resident-card-rotation">{r.rotation}</span>
                    </div>

                    <div className="resident-field">
                      <label>Rotation วอร์ดหมุนเวียน</label>
                      <select 
                        className="input-select"
                        value={r.rotation}
                        disabled={true}
                        style={{ 
                          opacity: 0.75, 
                          cursor: 'not-allowed',
                          borderColor: 'transparent'
                        }}
                        onChange={(e) => {}}
                      >
                        <option value="Cardio">Cardio</option>
                        <option value="ICU">ICU</option>
                        <option value="GI">GI</option>
                        <option value="ID">ID (Infectious)</option>
                        <option value="Chest">Chest</option>
                        <option value="Endo">Endo</option>
                        <option value="Nephro">Nephro</option>
                        <option value="Onco">Onco</option>
                        <option value="Neuro">Neuro</option>
                        <option value="Rheu">Rheu</option>
                        <option value="Skin/Geriatrics">Skin/Geriatrics</option>
                        <option value="Ambu">Ambu</option>
                        <option value="Elective">Elective</option>
                        <option value="Vacation">Vacation (พักร้อน)</option>
                      </select>
                    </div>

                    <div className="resident-field">
                      <label>วันคลินิก OPD (ห้ามจัดเวรก่อนหน้า)</label>
                      <div className="opd-selector-grid">
                        {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map(day => {
                          const active = r.opd_days.includes(day);
                          return (
                            <div 
                              key={day}
                              className={`opd-btn ${active ? 'active' : ''}`}
                              style={{ 
                                cursor: 'not-allowed', 
                                opacity: 0.7,
                                pointerEvents: 'none' 
                              }}
                              onClick={() => {}}
                            >
                              {day.substring(0, 3)}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="resident-field">
                      <label>วันที่ลาบล็อกไว้ (Blocked Dates)</label>
                      <div className="vacation-dates-container">
                        <div className="vacation-badge-list">
                          {r.blocked_dates.map(d => (
                            <span key={d} className="vacation-date-badge">
                              {d}
                              <X 
                                size={12} 
                                style={{ cursor: 'pointer', marginLeft: '6px' }}
                                onClick={() => {
                                  const updatedBlocked = r.blocked_dates.filter(b => b !== d);
                                  const updated = residents.map((item, idx) => 
                                    idx === rIdx ? { ...item, blocked_dates: updatedBlocked } : item
                                  );
                                  setResidents(updated);
                                }}
                              />
                            </span>
                          ))}
                        </div>
                        {/* Resident Portal requested blocked dates */}
                        {adminOverallBlockedDates[r.name] && adminOverallBlockedDates[r.name].length > 0 && (
                          <div style={{ marginTop: '10px', padding: '10px', background: 'rgba(99, 102, 241, 0.08)', borderRadius: '10px', border: '1px solid rgba(99,102,241,0.15)' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 'bold', color: 'var(--accent-primary)', marginBottom: '4px' }}>
                              คำขอลาจาก Resident Portal (Auto-merged into solver):
                            </div>
                            <div className="vacation-badge-list">
                              {adminOverallBlockedDates[r.name].map(d => (
                                <span key={d} className="vacation-date-badge" style={{ background: 'var(--accent-gradient)', color: '#white', fontSize: '0.75rem' }}>
                                  {d}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        <div style={{ marginTop: '8px' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ width: '100%', padding: '8px 12px', fontSize: '0.8rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '6px' }}
                            onClick={() => setCalendarModalResident(r)}
                          >
                            <Calendar size={14} /> เลือกวันหยุด/วันลาหลายวัน (Select Dates)
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Google Account Mappings Section (Admin View) */}
            <div className="glass-panel panel-card" style={{ marginTop: '30px', padding: '20px' }}>
              <h3>บัญชีผู้ใช้งานที่เชื่อมต่อแล้ว (Google Accounts Linked to Residents)</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                รายการแพทย์ที่ลงทะเบียน Google Account และเชื่อมต่อกับระบบแล้ว
              </p>
              
              <div className="table-container">
                <table className="schedule-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>ชื่อแพทย์ (Resident Name)</th>
                      <th>อีเมลเชื่อมต่อ (Google Account Email)</th>
                      <th>ปฏิทินของระบบ (System Calendar Link)</th>
                      <th style={{ width: '150px' }}>จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminMappings.length === 0 ? (
                      <tr>
                        <td colSpan="4" style={{ textAlign: 'center', opacity: 0.5, padding: '16px' }}>
                          ยังไม่มีบัญชีแพทย์เชื่อมโยงในระบบ
                        </td>
                      </tr>
                    ) : (
                      adminMappings.map((m) => (
                        <tr key={m.resident_name}>
                          <td style={{ fontWeight: 'bold' }}>{m.resident_name}</td>
                          <td>{m.email}</td>
                          <td>
                            <a 
                              href={getAbsoluteCalendarUrl(m.ical_token)}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', textDecoration: 'underline' }}
                            >
                              ดาวน์โหลด .ics
                            </a>
                          </td>
                          <td>
                            <button 
                              className="btn btn-danger"
                              style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                              onClick={() => handleUnmapResident(m.resident_name)}
                            >
                              ยกเลิกเชื่อมต่อ
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            
          </div>
        )}

        {/* ========================================================
            TAB: SETTINGS & IMPORT/EXPORT
            ======================================================== */}
        {activeTab === "settings" && (
          <div className="animate-fade-in">
            <div className="page-header">
              <div>
                <h2>ตั้งค่าช่วงเวลาจัดเวร และข้อมูล I/O</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  แก้ไขวันที่ของ rotation block, เพิ่มวันหยุดนักขัตฤกษ์ และส่งออกหรือนำเข้าไฟล์ CSV
                </p>
              </div>
            </div>

            <div className="settings-card glass-panel" style={{ marginBottom: '24px', padding: '24px' }}>
              <h3>ตั้งค่าช่วงเวลาปฏิบัติงาน (Rotation Block Settings)</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginTop: '16px' }}>
                <div className="form-group">
                  <label>ชื่อรอบการจัดเวร (e.g. Block 1)</label>
                  <input 
                    type="text" 
                    className="input-text"
                    value={blockName}
                    onChange={(e) => setBlockName(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>วันที่เริ่มต้น (Start Date)</label>
                  <input 
                    type="date" 
                    className="input-text"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>วันที่สิ้นสุด (End Date)</label>
                  <input 
                    type="date" 
                    className="input-text"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="settings-layout">
              {/* Left Panel: Holidays & Shifts */}
              <div className="glass-panel settings-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3>วันหยุดนักขัตฤกษ์ (Thai Public Holidays)</h3>
                  <button 
                    className="btn btn-secondary" 
                    style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                    onClick={fetchThaiHolidays}
                  >
                    <RefreshCw size={12} /> ดึงวันหยุดอัตโนมัติ
                  </button>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  วันหยุดนักขัตฤกษ์จะคิดภาระงานเป็นวันหยุด (เวรละ 24 ชั่วโมง) เหมือนวันเสาร์-อาทิตย์
                </p>
                <div className="holiday-adder" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input 
                    type="date" 
                    className="input-text" 
                    value={newHolidayDate}
                    onChange={(e) => setNewHolidayDate(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <input 
                    type="text" 
                    className="input-text" 
                    placeholder="ชื่อวันหยุด" 
                    value={newHolidayName}
                    onChange={(e) => setNewHolidayName(e.target.value)}
                    style={{ flex: 2 }}
                  />
                  <button 
                    className="btn btn-primary"
                    onClick={() => {
                      if (newHolidayDate && !holidays[newHolidayDate]) {
                        const name = newHolidayName.trim() || "วันหยุดพิเศษ";
                        setHolidays(prev => ({
                          ...prev,
                          [newHolidayDate]: name
                        }));
                        setNewHolidayDate("");
                        setNewHolidayName("");
                      }
                    }}
                  >
                    <Plus size={16} /> เพิ่ม
                  </button>
                </div>
                <div className="holidays-list">
                  {Object.keys(holidays).length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '10px' }}>
                      ไม่มีการกำหนดวันหยุดราชการเพิ่มเติม
                    </div>
                  ) : (
                    Object.entries(holidays).map(([dateStr, name]) => (
                      <div key={dateStr} className="holiday-item">
                        <span>{dateStr} ({new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' })}) - {name}</span>
                        <button className="btn-icon" onClick={() => {
                          const updated = { ...holidays };
                          delete updated[dateStr];
                          setHolidays(updated);
                        }}>
                          <X size={14} style={{ color: 'var(--color-danger)' }} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <h3 style={{ marginTop: '24px' }}>ตั้งค่าเวรพิเศษ (แยกโรค)</h3>
                <div className="form-group" style={{ marginTop: '10px' }}>
                  <label>วันที่เริ่มต้นเวรแยกโรคของรอบเดือนนี้</label>
                  <input 
                    type="date" 
                    className="input-text"
                    value={shiftTypes[3]?.active_from_date || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const updated = shiftTypes.map((item, idx) => 
                        idx === 3 ? { ...item, active_from_date: val } : item
                      );
                      setShiftTypes(updated);
                    }}
                  />
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    เวรแยกโรคจะทำงานตั้งแต่วันที่กำหนดเป็นต้นไปจนสิ้นสุดรอบเดือนนี้ (ค่าเริ่มต้นคือครึ่งหลังของเดือน)
                  </p>
                </div>
              </div>

              {/* Right Panel: File Import/Export */}
              <div className="glass-panel settings-card">
                <h3>การบันทึกข้อมูลและส่งออก (File I/O Manager)</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                  ส่งออกตารางเวรเป็นไฟล์ CSV เพื่อเปิดใน Excel/Google Sheets หรือนำเข้าตารางเพื่อทำการแก้ไขต่อ
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div style={{ border: '1px solid var(--border-glass)', borderRadius: '12px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ fontSize: '0.95rem' }}>ส่งออกข้อมูลตารางจัดเวร (Export Schedule)</h4>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        ดาวน์โหลดข้อมูลตารางจัดเวรปัจจุบันเป็นไฟล์ CSV
                      </p>
                    </div>
                    <button className="btn btn-primary" onClick={handleExportCSV}>
                      <Download size={16} /> Export CSV
                    </button>
                  </div>

                  <div style={{ border: '1px solid var(--border-glass)', borderRadius: '12px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ fontSize: '0.95rem' }}>นำเข้าตารางจัดเวร (Import Schedule CSV)</h4>
                      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        โหลดไฟล์ตารางจัดเวรเพื่อแก้ไขต่อ หรือเปลี่ยนข้อมูลในแอปพลิเคชัน
                      </p>
                    </div>
                    <label className="btn btn-secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
                      <Upload size={16} /> Import CSV
                      <input 
                        type="file" 
                        accept=".csv" 
                        style={{ display: 'none' }}
                        onChange={handleImportCSV}
                      />
                    </label>
                  </div>
                </div>

                <h3 style={{ marginTop: '24px' }}>รอยต่อช่วงเดือนก่อนหน้า (Previous Month Boundary)</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  ป้อนประวัติการทำเวรของ 2 วันสุดท้ายก่อนการหมุนเวียนนี้ เพื่อเช็คไม่ให้แพทย์เข้าเวรชนกันในวันแรกๆ
                </p>
                
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <input type="date" className="input-text" id="prev-date" style={{ flex: 1 }} />
                  <input type="text" className="input-text" id="prev-name" placeholder="ชื่อแพทย์" style={{ flex: 1 }} />
                  <select className="input-select" id="prev-shift" style={{ flex: 1 }}>
                    {shiftTypes.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                  </select>
                  <button 
                    className="btn btn-primary"
                    onClick={() => {
                      const dateEl = document.getElementById("prev-date");
                      const nameEl = document.getElementById("prev-name");
                      const shiftEl = document.getElementById("prev-shift");
                      
                      const dateVal = dateEl.value;
                      const nameVal = nameEl.value;
                      const shiftVal = shiftEl.value;
                      
                      if (dateVal && nameVal && shiftVal) {
                        setPrevAssignments([...prevAssignments, {
                          date: dateVal,
                          resident_name: nameVal,
                          shift_type: shiftVal
                        }]);
                        dateEl.value = "";
                        nameEl.value = "";
                      }
                    }}
                  >
                    เพิ่ม
                  </button>
                </div>

                <div style={{ border: '1px solid var(--border-glass)', borderRadius: '8px', padding: '10px', maxHeight: '120px', overflowY: 'auto' }}>
                  {prevAssignments.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>ไม่มีการระบุการทำงานก่อนหน้า</div>
                  ) : (
                    prevAssignments.map((p, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <span>{p.date} - {p.resident_name} ({p.shift_type})</span>
                        <button 
                          className="btn-icon"
                          onClick={() => setPrevAssignments(prevAssignments.filter((_, i) => i !== idx))}
                        >
                          <X size={12} style={{ color: 'var(--color-danger)' }} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            TAB: SAVED SCHEDULES (DATABASE VIEWER)
            ======================================================== */}
        {activeTab === "db" && (
          <div className="animate-fade-in">
            <div className="page-header">
              <div>
                <h2>ประวัติการจัดเวรแพทย์ในฐานข้อมูล (Saved Schedule Database)</h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  ดูตารางจัดเวรของเดือนก่อนๆ และดาวน์โหลดหรือโหลดกลับเข้าสู่ระบบ
                </p>
              </div>
            </div>

            <div className="saved-schedules-list">
              {savedBlocks.length === 0 ? (
                <div className="glass-panel" style={{ gridColumn: '1/-1', padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  <Database size={48} style={{ marginBottom: '16px', opacity: 0.3, color: 'var(--accent-primary)' }} />
                  <p>ไม่พบรายการที่เคยบันทึกไว้ในระบบฐานข้อมูล SQLite</p>
                </div>
              ) : (
                savedBlocks.map(b => (
                  <div key={b.id} className="glass-panel saved-schedule-card">
                    <div className="saved-schedule-header">{b.name}</div>
                    <div className="saved-schedule-dates">ช่วงเวลา: {b.start_date} ถึง {b.end_date}</div>
                    <div className="saved-schedule-actions">
                      <button className="btn btn-primary" onClick={() => handleLoadBlock(b.id)}>
                        โหลดขึ้นมาแก้ไข (Load)
                      </button>
                      <button className="btn btn-danger btn-icon" onClick={() => handleDeleteBlock(b.id)}>
                        <Trash size={16} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        {activeTab === "stats" && renderStatsView()}
        {/* ========================================================
            MODAL: MULTIPLE DATE SELECTION CALENDAR
            ======================================================== */}
        {calendarModalResident && (
          <div className="modal-overlay" onClick={() => setCalendarModalResident(null)}>
            <div className="modal-window glass-panel" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3 style={{ margin: 0, fontSize: '1.2rem', fontFamily: 'var(--font-title)' }}>
                  เลือกวันหยุด/วันลา: {calendarModalResident.name}
                </h3>
                <button className="btn-icon" onClick={() => setCalendarModalResident(null)}>
                  <X size={18} />
                </button>
              </div>

              <div className="modal-body">
                <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: '1.4' }}>
                  คลิกเลือกวันที่แพทย์ต้องการลาพักร้อน/วันลาในรอบนี้ (คลิกหลายวันได้ทันที)
                </p>

                {getMonthsInRange().map(({ year, month }) => {
                  const days = generateMonthDays(year, month);
                  const monthLabel = new Date(year, month, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
                  
                  return (
                    <div key={`${year}-${month}`} className="calendar-month-section">
                      <div className="calendar-month-title">{monthLabel}</div>
                      <div className="calendar-grid">
                        {/* Week headers */}
                        {['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map(h => (
                          <div key={h} className="calendar-header-day">{h}</div>
                        ))}

                        {/* Calendar days */}
                        {days.map((day, dIdx) => {
                          if (!day) return <div key={`empty-${dIdx}`} className="calendar-day-empty" />;
                          
                          const isBlocked = residents.find(res => res.name === calendarModalResident.name)?.blocked_dates.includes(day.dateStr);
                          
                          return (
                            <button
                              key={day.dateStr}
                              className={`calendar-day-btn ${day.isWeekend ? 'weekend' : ''} ${day.isHoliday ? 'holiday' : ''} ${isBlocked ? 'blocked' : ''} ${!day.isInBlock ? 'inactive' : ''}`}
                              disabled={!day.isInBlock}
                              onClick={() => {
                                setResidents(prev => {
                                  return prev.map(res => {
                                    if (res.name === calendarModalResident.name) {
                                      const alreadyBlocked = res.blocked_dates.includes(day.dateStr);
                                      const newBlocked = alreadyBlocked
                                        ? res.blocked_dates.filter(d => d !== day.dateStr)
                                        : [...res.blocked_dates, day.dateStr].sort();
                                      return { ...res, blocked_dates: newBlocked };
                                    }
                                    return res;
                                  });
                                });
                              }}
                            >
                              {day.dayNum}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px' }}>
                <button className="btn btn-primary" onClick={() => setCalendarModalResident(null)}>
                  เสร็จสิ้น (Done)
                </button>
              </div>
            </div>
          </div>
        )}
        
        {/* ========================================================
            MODAL: SHARE SCHEDULE IMAGE (9:16 ASPECT RATIO)
            ======================================================== */}
        {showShareModal && (
          <div className="modal-overlay" onClick={() => setShowShareModal(false)}>
            <div className="modal-window glass-panel share-modal-window" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3 style={{ margin: 0, fontSize: '1.2rem', fontFamily: 'var(--font-title)' }}>
                  แชร์ตารางเวรเป็นรูปภาพ (Export Schedule Image)
                </h3>
                <button className="btn-icon" onClick={() => setShowShareModal(false)}>
                  <X size={18} />
                </button>
              </div>

              <div className="modal-body">
                <div className="share-modal-layout">
                  
                  {/* Left Column: Phone Preview Mock */}
                  <div className="share-preview-column">
                    <div className="share-preview-container">
                      {/* This is the actual 9:16 card element that we will export.
                          It is rendered at 540x960px but scaled down to 50% (270x480px) in CSS preview. */}
                      <div className={`share-card-actual ${shareLayout === 'table' ? 'layout-table' : ''}`} ref={shareCardRef}>
                        <div className="share-card-bg-glow blob-1"></div>
                        <div className="share-card-bg-glow blob-2"></div>
                        
                        {/* Card Header */}
                        <div className="share-card-header">
                          <div className="share-card-header-left">
                            <h4>{blockName || "ตารางเวรปฏิบัติงาน"}</h4>
                            <p>แพทย์ประจำบ้านสาขาอายุรศาสตร์</p>
                          </div>
                          <div className="share-card-badge">
                            9:16 MOBILE
                          </div>
                        </div>

                        {/* Card Body - Split based on layout selected */}
                        <div className="share-card-body">
                          {shareLayout === 'table' ? (
                            <div className="share-table-wrapper" style={{ width: '100%' }}>
                              <table className="share-grid-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'sans-serif' }}>
                                <thead>
                                  <tr>
                                    <th style={{ backgroundColor: '#fceae2', border: '1px solid #cbd5e1', height: '28px', width: '45px' }}></th>
                                    <th colSpan={shiftTypes.length + 1} style={{ textAlign: 'center', fontSize: '13px', fontWeight: 'bold', backgroundColor: '#ffffff', border: '1px solid #cbd5e1', color: '#000000', padding: '6px' }}>
                                      {getThaiMonthYear(startDate)}
                                    </th>
                                  </tr>
                                  <tr style={{ backgroundColor: '#ffffff' }}>
                                    <th style={{ border: '1px solid #cbd5e1', backgroundColor: '#fceae2', height: '26px', color: '#1e293b', fontWeight: '600', fontSize: '11px' }}>Date</th>
                                    <th style={{ border: '1px solid #cbd5e1', color: '#1e293b', fontWeight: '600', fontSize: '11px', width: '75px' }}>Day</th>
                                    {shiftTypes.map(st => (
                                      <th key={st.name} style={{ border: '1px solid #cbd5e1', color: '#1e293b', fontWeight: '600', fontSize: '11px' }}>
                                        {st.display_name}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {getDatesArray().map(d_str => {
                                    const d_val = new Date(d_str);
                                    const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6;
                                    const is_hol = !!holidays[d_str];
                                    const daysLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                                    const dayName = daysLong[d_val.getDay()];
                                    const dateNum = parseInt(d_str.split('-')[2], 10);
                                    
                                    let rowBg = '#ffffff';
                                    if (is_hol) {
                                      rowBg = '#fef2f2';
                                    } else if (is_wk) {
                                      rowBg = '#fffbeb';
                                    }
                                    
                                    return (
                                      <tr key={d_str} style={{ backgroundColor: rowBg }}>
                                        <td style={{ border: '1px solid #cbd5e1', backgroundColor: '#fceae2', textAlign: 'center', fontWeight: '500', height: '23px', color: '#1e293b' }}>
                                          {dateNum}
                                        </td>
                                        <td style={{ border: '1px solid #cbd5e1', paddingLeft: '8px', color: '#1e293b' }}>
                                          {dayName}
                                          {is_hol && <span style={{ fontSize: '8px', color: '#ef4444', marginLeft: '4px', fontWeight: 'bold' }}>HOL</span>}
                                        </td>
                                        {shiftTypes.map(st => {
                                          const assign = assignments.find(a => a.date === d_str && a.shift_type === st.name);
                                          return (
                                            <td key={st.name} style={{ border: '1px solid #cbd5e1', paddingLeft: '8px', color: '#1e293b', fontWeight: assign ? '500' : 'normal' }}>
                                              {assign ? assign.resident_name : ""}
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          ) : shareLayout === 'split' ? (
                            <>
                              {/* Column 1: Days 1-16 */}
                              <div className="share-body-column">
                                {getDatesArray().slice(0, Math.ceil(getDatesArray().length / 2)).map(d_str => {
                                  const d_val = new Date(d_str);
                                  const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6;
                                  const is_hol = !!holidays[d_str];
                                  const daysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                                  const dayAbbr = daysShort[d_val.getDay()];
                                  const dateNum = d_str.split('-')[2];
                                  
                                  const shiftColors = {
                                    "MICU": "#818cf8",
                                    "CCU": "#34d399",
                                    "ต่างแผนก": "#fbbf24",
                                    "แยกโรค": "#f472b6"
                                  };
                                  const shiftAbbr = {
                                    "MICU": "M",
                                    "CCU": "C",
                                    "ต่างแผนก": "ต",
                                    "แยกโรค": "ย"
                                  };
                                  
                                  return (
                                    <div key={d_str} className={`share-day-row ${is_wk ? 'weekend-row' : ''} ${is_hol ? 'holiday-row' : ''}`}>
                                      <div className="share-day-date">
                                        <span className="share-day-num">{dateNum}</span>
                                        <span className="share-day-name">{is_hol ? "HOL" : dayAbbr}</span>
                                      </div>
                                      <div className="share-day-shifts-grid">
                                        {["MICU", "CCU", "ต่างแผนก", "แยกโรค"].map(s_name => {
                                          const isActive = getActiveShiftsForDay(d_str).includes(s_name);
                                          if (!isActive) {
                                            return (
                                              <div key={s_name} className="share-shift-pill inactive">
                                                <span className="share-shift-tag" style={{ color: '#4b5563' }}>{shiftAbbr[s_name]}:</span> -
                                              </div>
                                            );
                                          }
                                          const assign = assignments.find(a => a.date === d_str && a.shift_type === s_name);
                                          return (
                                            <div key={s_name} className="share-shift-pill">
                                              <span className="share-shift-tag" style={{ color: shiftColors[s_name] }}>{shiftAbbr[s_name]}:</span>
                                              {assign ? assign.resident_name : "ไม่มี"}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              {/* Column 2: Days 17 to End */}
                              <div className="share-body-column">
                                {getDatesArray().slice(Math.ceil(getDatesArray().length / 2)).map(d_str => {
                                  const d_val = new Date(d_str);
                                  const is_wk = d_val.getDay() === 0 || d_val.getDay() === 6;
                                  const is_hol = !!holidays[d_str];
                                  const daysShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                                  const dayAbbr = daysShort[d_val.getDay()];
                                  const dateNum = d_str.split('-')[2];
                                  
                                  const shiftColors = {
                                    "MICU": "#818cf8",
                                    "CCU": "#34d399",
                                    "ต่างแผนก": "#fbbf24",
                                    "แยกโรค": "#f472b6"
                                  };
                                  const shiftAbbr = {
                                    "MICU": "M",
                                    "CCU": "C",
                                    "ต่างแผนก": "ต",
                                    "แยกโรค": "ย"
                                  };
                                  
                                  return (
                                    <div key={d_str} className={`share-day-row ${is_wk ? 'weekend-row' : ''} ${is_hol ? 'holiday-row' : ''}`}>
                                      <div className="share-day-date">
                                        <span className="share-day-num">{dateNum}</span>
                                        <span className="share-day-name">{is_hol ? "HOL" : dayAbbr}</span>
                                      </div>
                                      <div className="share-day-shifts-grid">
                                        {["MICU", "CCU", "ต่างแผนก", "แยกโรค"].map(s_name => {
                                          const isActive = getActiveShiftsForDay(d_str).includes(s_name);
                                          if (!isActive) {
                                            return (
                                              <div key={s_name} className="share-shift-pill inactive">
                                                <span className="share-shift-tag" style={{ color: '#4b5563' }}>{shiftAbbr[s_name]}:</span> -
                                              </div>
                                            );
                                          }
                                          const assign = assignments.find(a => a.date === d_str && a.shift_type === s_name);
                                          return (
                                            <div key={s_name} className="share-shift-pill">
                                              <span className="share-shift-tag" style={{ color: shiftColors[s_name] }}>{shiftAbbr[s_name]}:</span>
                                              {assign ? assign.resident_name : "ไม่มี"}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          ) : (
                            <>
                              {/* Resident Groups Columns */}
                              <div className="share-resident-column">
                                {Object.keys(getResidentShifts()).slice(0, Math.ceil(Object.keys(getResidentShifts()).length / 2)).map(r_name => {
                                  const data = getResidentShifts()[r_name];
                                  return (
                                    <div key={r_name} className="share-resident-card">
                                      <div className="share-res-card-header">
                                        <span className="share-res-card-name">{r_name}</span>
                                        <span className="share-res-card-rot">{data.rotation || "None"}</span>
                                      </div>
                                      <div className="share-res-card-shifts">
                                        {data.shifts.length > 0 ? (
                                          data.shifts.map((sLabel, idx) => (
                                            <span key={idx} className="share-res-shift-badge">
                                              {sLabel}
                                            </span>
                                          ))
                                        ) : (
                                          <span style={{ fontSize: '9px', color: '#6b7280', fontStyle: 'italic' }}>ไม่มีเวรในรอบนี้</span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              <div className="share-resident-column">
                                {Object.keys(getResidentShifts()).slice(Math.ceil(Object.keys(getResidentShifts()).length / 2)).map(r_name => {
                                  const data = getResidentShifts()[r_name];
                                  return (
                                    <div key={r_name} className="share-resident-card">
                                      <div className="share-res-card-header">
                                        <span className="share-res-card-name">{r_name}</span>
                                        <span className="share-res-card-rot">{data.rotation || "None"}</span>
                                      </div>
                                      <div className="share-res-card-shifts">
                                        {data.shifts.length > 0 ? (
                                          data.shifts.map((sLabel, idx) => (
                                            <span key={idx} className="share-res-shift-badge">
                                              {sLabel}
                                            </span>
                                          ))
                                        ) : (
                                          <span style={{ fontSize: '9px', color: '#6b7280', fontStyle: 'italic' }}>ไม่มีเวรในรอบนี้</span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>

                        {/* Card Footer */}
                        <div className="share-card-footer">
                          <div className="share-card-legend">
                            <span className="share-card-legend-item">M: MICU</span>
                            <span className="share-card-legend-item">C: CCU</span>
                            <span className="share-card-legend-item">ต: ต่างแผนก</span>
                            <span className="share-card-legend-item">ย: แยกโรค</span>
                          </div>
                          <div className="share-card-footer-right">
                            <span className="share-card-footer-timestamp">สร้างเมื่อ: {new Date().toLocaleDateString('th-TH')}</span>
                            <span className="share-card-footer-brand">IM SHIFT SCHEDULER</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>พรีวิวขนาดจริงเมื่อแชร์บนมือถือ</span>
                  </div>

                  {/* Right Column: Options & Action Buttons */}
                  <div className="share-actions-column">
                    <div className="share-options-panel">
                      <div className="share-option-title">1. เลือกรูปแบบการแสดงผล (Select Layout)</div>
                      <div className="share-layout-picker">
                        <button 
                          className={`share-layout-btn ${shareLayout === 'table' ? 'active' : ''}`}
                          onClick={() => setShareLayout('table')}
                        >
                          <span className="share-layout-btn-icon">📊</span>
                          <span>ตารางรายเดือนเดี่ยว</span>
                        </button>
                        <button 
                          className={`share-layout-btn ${shareLayout === 'split' ? 'active' : ''}`}
                          onClick={() => setShareLayout('split')}
                        >
                          <span className="share-layout-btn-icon">📅</span>
                          <span>รายวันคอลัมน์คู่</span>
                        </button>
                        <button 
                          className={`share-layout-btn ${shareLayout === 'residents' ? 'active' : ''}`}
                          onClick={() => setShareLayout('residents')}
                        >
                          <span className="share-layout-btn-icon">👤</span>
                          <span>สรุปเวรรายบุคคล</span>
                        </button>
                      </div>
                    </div>

                    <div className="share-options-panel" style={{ marginTop: '8px' }}>
                      <div className="share-option-title">2. ดำเนินการ (Actions)</div>
                      <div className="share-buttons-group">
                        <button 
                          className="btn btn-primary" 
                          onClick={handleCopyShare}
                          disabled={isGeneratingShare}
                          style={{ padding: '12px', gap: '8px', fontSize: '0.95rem' }}
                        >
                          {isGeneratingShare ? <RefreshCw className="animate-spin" size={16} /> : <Copy size={16} />}
                          คัดลอกรูปภาพ (Copy to Clipboard)
                        </button>
                        <button 
                          className="btn btn-secondary" 
                          onClick={handleDownloadShare}
                          disabled={isGeneratingShare}
                          style={{ padding: '12px', gap: '8px', fontSize: '0.95rem' }}
                        >
                          {isGeneratingShare ? <RefreshCw className="animate-spin" size={16} /> : <Camera size={16} />}
                          ดาวน์โหลดภาพ PNG (Download PNG)
                        </button>
                      </div>
                    </div>

                    {shareNotification && (
                      <div className="share-notification-banner">
                        {shareNotification}
                      </div>
                    )}
                    
                    <div className="glass-panel" style={{ padding: '14px', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                      <strong>💡 เคล็ดลับ:</strong>
                      <ul style={{ paddingLeft: '16px', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <li>ปุ่ม <strong>Copy to Clipboard</strong> จะเซฟรูปลงคลิปบอร์ดเพื่อให้คุณกด Paste (ส่งต่อ) เข้าในกลุ่ม LINE ได้ทันที</li>
                        <li>ขนาดภาพถูกปรับอัตราส่วนแบบ <strong>9:16</strong> เพื่อให้เหมาะสมกับการส่งเปิดอ่านบนมือถือได้อย่างคมชัด</li>
                      </ul>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

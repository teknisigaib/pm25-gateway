const express = require("express");
const ftp = require("basic-ftp");
const cron = require("node-cron");
const cors = require("cors");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());

const DB_FILE = "./local-db.json";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep", "Okt", "Nov", "Des"];
const FTP_DIR = "SAMARINDA2/WASUploaded"; 

// --- STATE AWAL ---
let airQualityState = {
  success: false,
  current: 0,
  lastUpdate: "-",
  history: []
};

// Load data dari cache lokal jika ada
if (fs.existsSync(DB_FILE)) {
  try {
    const savedData = fs.readFileSync(DB_FILE, "utf-8");
    airQualityState = JSON.parse(savedData);
  } catch (e) {
    console.error("Gagal membaca local-db.json");
  }
}

// --- FUNGSI PARSING 1 FILE CSV ---
function parseSingleCSV(csvText) {
  const lines = csvText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const dataLines = lines.slice(2); 
  
  if (dataLines.length === 0) return null;

  const lastLine = dataLines[dataLines.length - 1];
  const cols = lastLine.split(',');
  
  if (cols.length >= 3) {
    let pm25Val = parseFloat(cols[2]);
    if (!isNaN(pm25Val) && (pm25Val < 0 || pm25Val === 99999.9)) { 
      pm25Val = 0; 
    }

    return {
      dateStr: cols[0], 
      time: cols[1],    
      pm25: isNaN(pm25Val) ? null : pm25Val
    };
  }
  return null;
}

// --- FUNGSI UTAMA PENARIK FTP ---
async function syncPM25FromFTP() {
  const client = new ftp.Client();
  client.ftp.verbose = false; 

  try {
    console.log(`[${new Date().toLocaleString()}] Cek FTP BMKG...`);
    
    await client.access({
      host: (process.env.FTP_HOST || "").trim(),
      user: (process.env.FTP_USER || "").trim(),
      password: (process.env.FTP_PASS || "").trim(),
      port: 21,
      secure: false
    });

    await client.cd(FTP_DIR);
    const fileList = await client.list();
    
    const csvFiles = fileList.filter(f => f.name.toLowerCase().endsWith(".csv") && f.name.includes("BAM"));
    if (csvFiles.length === 0) throw new Error("Tidak ada file CSV");

    csvFiles.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    let filesToDownload = [];
    // PERUBAHAN: Cek apakah data kurang dari 240 jam (10 hari)
    if (airQualityState.history.length < 240) { 
      console.log("History kosong/kurang! Menyedot 10 hari terakhir (240 file) dari FTP...");
      // PERUBAHAN: Ambil 240 file terbaru
      filesToDownload = csvFiles.slice(0, 240).reverse();
    } else {
      filesToDownload = [csvFiles[0]]; 
    }

    let latestParsed = null;
    const historyMap = new Map();
    airQualityState.history.forEach(item => {
      if (item.dateStr && item.time) {
        historyMap.set(`${item.dateStr}_${item.time}`, item);
      }
    });

    for (let file of filesToDownload) {
      const tempFileName = "temp_pm25.csv";
      await client.downloadTo(tempFileName, file.name);

      const rawData = fs.readFileSync(tempFileName, "utf-8");
      const parsedRow = parseSingleCSV(rawData);

      if (parsedRow) {
        latestParsed = parsedRow;
        historyMap.set(`${parsedRow.dateStr}_${parsedRow.time}`, {
          dateStr: parsedRow.dateStr,
          time: parsedRow.time,
          pm25: parsedRow.pm25
        });
      }
      fs.unlinkSync(tempFileName); 
    }

    airQualityState.history = Array.from(historyMap.values());

    airQualityState.history.sort((a, b) => {
      const getTimestamp = (dStr, tStr) => {
        const [month, day, year] = dStr.split('-');
        const [hour, minute] = tStr.split(':');
        return new Date(year, parseInt(month) - 1, day, hour, minute).getTime();
      };
      return getTimestamp(a.dateStr, a.time) - getTimestamp(b.dateStr, b.time);
    });

    // PERUBAHAN: Pastikan array selalu berjumlah max 240 jam terakhir (10 hari)
    airQualityState.history = airQualityState.history.slice(-240);

    if (latestParsed) {
      airQualityState.success = true;
      const mostRecent = airQualityState.history[airQualityState.history.length - 1];
      airQualityState.current = mostRecent.pm25 || 0;

      const dateParts = mostRecent.dateStr.split('-');
      let formattedDate = "";
      if (dateParts.length >= 2) {
        const monthIndex = parseInt(dateParts[0]) - 1;
        const dayNum = parseInt(dateParts[1]);
        formattedDate = `${dayNum} ${MONTHS[monthIndex] || ""}`;
      }
      airQualityState.lastUpdate = `${formattedDate} ${mostRecent.time} WITA`;
    }

    fs.writeFileSync(DB_FILE, JSON.stringify(airQualityState, null, 2));
    console.log(`Sinkronisasi Selesai! PM2.5 Terkini: ${airQualityState.current} µg/m³`);

  } catch (err) {
    console.error("FTP Sync Error:", err.message);
  } finally {
    client.close();
  }
}

// --- PENJADWALAN (CRON JOB) ---
cron.schedule("*/5 * * * *", () => {
  syncPM25FromFTP();
});
syncPM25FromFTP();

// --- REST API ENDPOINT: 24 Jam Terakhir ---
app.get("/api/v1/pm25", (req, res) => {
  if (!airQualityState.success && airQualityState.history.length === 0) {
    return res.status(503).json({ error: "Data PM2.5 belum tersedia." });
  }
  
  const responseData = {
    success: airQualityState.success,
    current: airQualityState.current,
    lastUpdate: airQualityState.lastUpdate,
    // PERUBAHAN: Hanya kirim 24 data terakhir agar frontend lama tidak rusak
    history: airQualityState.history.slice(-24).map(item => ({
      time: item.time,
      pm25: item.pm25
    }))
  };

  res.json(responseData);
});

// --- REST API ENDPOINT BARU: Rata-Rata 10 Hari Terakhir ---
app.get("/api/v1/pm25/daily", (req, res) => {
  if (!airQualityState.success && airQualityState.history.length === 0) {
    return res.status(503).json({ error: "Data PM2.5 belum tersedia." });
  }

  // 1. Kelompokkan data berdasarkan tanggal (dateStr)
  const dailyGroups = {};
  
  airQualityState.history.forEach(item => {
    if (!dailyGroups[item.dateStr]) {
      dailyGroups[item.dateStr] = { sum: 0, count: 0 };
    }
    // Jika ada nilai PM2.5 (tidak null), tambahkan ke total sum
    if (item.pm25 !== null) {
      dailyGroups[item.dateStr].sum += item.pm25;
      dailyGroups[item.dateStr].count += 1;
    }
  });

  // 2. Hitung rata-rata per hari
  const dailyAverages = Object.keys(dailyGroups).map(dateStr => {
    const group = dailyGroups[dateStr];
    // Cegah pembagian dengan 0
    const avg = group.count > 0 ? (group.sum / group.count) : 0;
    
    // Format tanggal menjadi cantik (Contoh: "15 Mei")
    const dateParts = dateStr.split('-');
    let formattedDate = dateStr;
    if (dateParts.length >= 2) {
      const monthIndex = parseInt(dateParts[0]) - 1;
      const dayNum = parseInt(dateParts[1]);
      formattedDate = `${dayNum} ${MONTHS[monthIndex] || ""}`;
    }

    return {
      date: formattedDate,
      average_pm25: parseFloat(avg.toFixed(2)) // Dibulatkan ke 2 angka desimal
    };
  });

  // 3. Ambil maksimal 10 hari terakhir
  const last10Days = dailyAverages.slice(-10);

  res.json({
    success: true,
    data: last10Days
  });
});

const PORT = process.env.PORT;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API Gateway PM2.5 berjalan di port ${PORT}`); 
});
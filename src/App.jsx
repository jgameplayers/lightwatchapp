import { useState, useMemo, useRef, useEffect } from "react";
import {
  Nfc as NfcIcon, Zap, AlertTriangle, CheckCircle2, XCircle, Search, ArrowLeft,
  Clock, MapPin, Wrench, Filter, X, Plus, WifiOff, Activity,
  ClipboardList, Home, Send, Calendar, ChevronRight, Pencil, Trash2,
  Check
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { CapacitorNfc } from "@capgo/capacitor-nfc";
import { supabase } from "./supabaseClient";

// ---------------------------------------------------------------------------
// Native NFC (via @capgo/capacitor-nfc — a free, public alternative to the
// paid Capawesome Insiders NFC plugin). This app runs as a Capacitor-wrapped
// native shell, so NFC only works in that native build (not in a plain
// Safari/Chrome tab) — hence checking Capacitor.isNativePlatform().
// ---------------------------------------------------------------------------
function buildNdefTextRecord(text) {
  const encoder = new TextEncoder();
  const langBytes = Array.from(encoder.encode("en"));
  const textBytes = Array.from(encoder.encode(text));
  const payload = [langBytes.length & 0x3f, ...langBytes, ...textBytes];
  return {
    tnf: 0x01,
    type: [0x54],
    id: [],
    payload,
  };
}

function decodeNdefTextRecord(record) {
  try {
    const raw = record?.payload;
    if (!raw) return "";
    const bytes = Array.isArray(raw) ? raw : Object.values(raw);
    const languageCodeLength = bytes[0] & 0x3f;
    const textBytes = bytes.slice(1 + languageCodeLength);
    return new TextDecoder("utf-8").decode(new Uint8Array(textBytes)).trim();
  } catch {
    return "";
  }
}

function nfcErrorMessage(err, kind) {
  const raw = (err?.message || "").toLowerCase();
  if (raw.includes("denied") || raw.includes("not_authorized") || err?.code === "NOT_AUTHORIZED") {
    return "NFC permission was denied. Enable NFC access for this app in Settings and try again.";
  }
  if (raw.includes("not available") || raw.includes("unavailable") || err?.code === "UNAVAILABLE") {
    return kind === "write" ? "This device doesn't have an NFC reader/writer." : "This device doesn't have an NFC reader.";
  }
  if (raw.includes("cancel") || raw.includes("abort")) {
    return null; // user dismissed the native scan sheet — not a real error
  }
  return kind === "write"
    ? "Couldn't write to the tag. Make sure NFC is turned on and try again."
    : "Couldn't start the NFC scan. Make sure NFC is turned on and try again.";
}

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLOR = {
  base: "#0E1215",
  surface: "#171D22",
  surfaceRaised: "#1F262C",
  border: "#2A323A",
  borderFaint: "#20272D",
  textPrimary: "#EDEFF2",
  textSecondary: "#8D97A3",
  textTertiary: "#5B6472",
  amber: "#FFB236",
  amberDim: "#7A5A22",
  green: "#3ECF8E",
  red: "#FF5C5C",
  gray: "#5B6472",
};

const STATUS = {
  operational: { label: "Operational", color: COLOR.green, Icon: CheckCircle2 },
  warning: { label: "Needs attention", color: COLOR.amber, Icon: AlertTriangle },
  fault: { label: "Fault", color: COLOR.red, Icon: XCircle },
  offline: { label: "Offline", color: COLOR.gray, Icon: WifiOff },
};

const SEVERITY = {
  low: { label: "Low", color: COLOR.textSecondary },
  medium: { label: "Medium", color: COLOR.amber },
  high: { label: "High", color: "#FF8A5C" },
  critical: { label: "Critical", color: COLOR.red },
};

// ---------------------------------------------------------------------------
// Starting data — empty. Fixtures are added for real via the "Add" button
// (Lights tab), then written to an NFC tag from that same screen. Scanning
// a written tag later brings you straight to that fixture.
// ---------------------------------------------------------------------------
const INITIAL_LIGHTS = [];
const INITIAL_LOGS = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const day = 86400000;
  const days = Math.floor(diff / day);
  if (days < 1) {
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return "just now";
    return `${hrs}h ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDate(ds) {
  return new Date(ds).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Small shared UI
// ---------------------------------------------------------------------------
function StatusPill({ status, size = "md" }) {
  const s = STATUS[status];
  const Icon = s.Icon;
  const pad = size === "sm" ? "2px 8px" : "4px 10px";
  const fs = size === "sm" ? 11 : 12;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: pad, borderRadius: 999, fontSize: fs, fontWeight: 600,
        color: s.color, background: s.color + "1A", border: `1px solid ${s.color}33`,
        fontFamily: "Inter, sans-serif", whiteSpace: "nowrap",
      }}
    >
      <Icon size={size === "sm" ? 11 : 12} strokeWidth={2.5} />
      {s.label}
    </span>
  );
}

function SeverityDot({ severity }) {
  const s = SEVERITY[severity];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: s.color, fontFamily: "Inter, sans-serif" }}>{s.label}</span>
    </span>
  );
}

function ScreenHeader({ title, subtitle, onBack, right }) {
  return (
    <div style={{ padding: "18px 18px 14px", borderBottom: `1px solid ${COLOR.borderFaint}`, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {onBack && (
          <button onClick={onBack} style={{ background: COLOR.surfaceRaised, border: `1px solid ${COLOR.border}`, borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textPrimary, flexShrink: 0 }}>
            <ArrowLeft size={15} />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, fontWeight: 600, color: COLOR.textPrimary, letterSpacing: "-0.02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12.5, color: COLOR.textSecondary, marginTop: 2, fontFamily: "Inter, sans-serif" }}>{subtitle}</div>}
        </div>
        {right}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan screen (home) — the signature moment
// ---------------------------------------------------------------------------
function ScanScreen({ lights, logs, onOpenLight, scanning, onScan, nfcSupported, scanError }) {
  const openIssues = logs.filter((l) => !l.resolved).length;
  const faultCount = lights.filter((l) => l.status === "fault").length;
  const recent = [...lights]
    .sort((a, b) => new Date(b.lastServiced) - new Date(a.lastServiced))
    .slice(0, 4);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "22px 20px 4px", flexShrink: 0 }}>
        <div style={{ fontSize: 12, color: COLOR.textTertiary, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.04em", textTransform: "uppercase" }}>Riverside Distribution Center</div>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 24, fontWeight: 600, color: COLOR.textPrimary, letterSpacing: "-0.02em", marginTop: 2 }}>LightWatch</div>
      </div>

      {/* stat row */}
      <div style={{ display: "flex", gap: 10, padding: "16px 20px 4px", flexShrink: 0 }}>
        <StatCard label="Fixtures" value={lights.length} accent={COLOR.textPrimary} />
        <StatCard label="Open issues" value={openIssues} accent={openIssues ? COLOR.amber : COLOR.green} />
        <StatCard label="Faults" value={faultCount} accent={faultCount ? COLOR.red : COLOR.green} />
      </div>

      {/* scan module */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "10px 20px 20px", position: "relative" }}>
        <button
          onClick={onScan}
          disabled={scanning}
          style={{ position: "relative", width: 172, height: 172, background: "none", border: "none", cursor: scanning ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: nfcSupported ? 1 : 0.5 }}
        >
          {scanning && (
            <>
              <span className="lw-pulse-ring" style={{ animationDelay: "0s" }} />
              <span className="lw-pulse-ring" style={{ animationDelay: "0.5s" }} />
              <span className="lw-pulse-ring" style={{ animationDelay: "1s" }} />
            </>
          )}
          <div
            style={{
              width: 108, height: 108, borderRadius: "50%",
              background: scanning ? `radial-gradient(circle, ${COLOR.amber}26 0%, ${COLOR.surfaceRaised} 70%)` : COLOR.surfaceRaised,
              border: `1.5px solid ${scanning ? COLOR.amber + "80" : COLOR.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.3s ease", zIndex: 1,
            }}
          >
            <NfcIcon size={38} strokeWidth={1.6} color={scanning ? COLOR.amber : COLOR.textSecondary} />
          </div>
        </button>
        <div style={{ marginTop: 22, textAlign: "center" }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 15, fontWeight: 600, color: COLOR.textPrimary }}>
            {scanning ? "Reading tag…" : "Tap to scan a fixture"}
          </div>
          <div style={{ fontSize: 12.5, color: COLOR.textTertiary, marginTop: 4, fontFamily: "Inter, sans-serif" }}>
            {scanning ? "Hold your phone near the NFC label" : "Hold your phone near the light's NFC label"}
          </div>
          {!nfcSupported && (
            <div style={{ fontSize: 11.5, color: COLOR.amber, marginTop: 10, maxWidth: 240, fontFamily: "Inter, sans-serif" }}>
              This can't read NFC here. Scanning needs the installed LightWatch app (not a browser tab), on a device with NFC turned on.
            </div>
          )}
          {scanError && (
            <div style={{ fontSize: 11.5, color: COLOR.red, marginTop: 10, maxWidth: 250, fontFamily: "Inter, sans-serif" }}>
              {scanError}
            </div>
          )}
        </div>
      </div>

      {/* recent */}
      <div style={{ padding: "0 20px 18px", flexShrink: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, fontFamily: "Inter, sans-serif" }}>Recently serviced</div>
        {lights.length === 0 && (
          <div style={{ fontSize: 12.5, color: COLOR.textTertiary, fontFamily: "Inter, sans-serif" }}>
            No fixtures yet — add one from the Lights tab, then write it to an NFC tag.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {recent.map((l) => (
            <button key={l.id} onClick={() => onOpenLight(l.id)} style={{ display: "flex", alignItems: "center", gap: 10, background: COLOR.surface, border: `1px solid ${COLOR.borderFaint}`, borderRadius: 10, padding: "9px 11px", textAlign: "left" }}>
              <StatusDotSmall status={l.status} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLOR.textPrimary, fontFamily: "Inter, sans-serif" }}>{l.id} · {l.zone}</div>
              </div>
              <ChevronRight size={14} color={COLOR.textTertiary} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div style={{ flex: 1, background: COLOR.surface, border: `1px solid ${COLOR.borderFaint}`, borderRadius: 12, padding: "12px 10px" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: COLOR.textTertiary, marginTop: 2, fontFamily: "Inter, sans-serif" }}>{label}</div>
    </div>
  );
}

function StatusDotSmall({ status }) {
  const s = STATUS[status];
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0, boxShadow: `0 0 6px ${s.color}99` }} />;
}

// ---------------------------------------------------------------------------
// Lights database screen
// ---------------------------------------------------------------------------
function LightsScreen({ lights, onOpenLight, onAddFixture }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("id");

  const filtered = lights.filter((l) => {
    const matchesFilter = filter === "all" || l.status === filter;
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || l.id.toLowerCase().includes(q) || l.zone.toLowerCase().includes(q) || l.type.toLowerCase().includes(q);
    return matchesFilter && matchesQuery;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "zone":
        return a.zone.localeCompare(b.zone);
      case "type":
        return a.type.localeCompare(b.type);
      case "status":
        return a.status.localeCompare(b.status);
      case "lastServiced":
        return (b.lastServiced || "").localeCompare(a.lastServiced || "");
      case "id":
      default:
        return a.id.localeCompare(b.id);
    }
  });

  const filters = [
    { key: "all", label: "All" },
    { key: "fault", label: "Fault" },
    { key: "warning", label: "Warning" },
    { key: "operational", label: "OK" },
    { key: "offline", label: "Offline" },
  ];

  const sortOptions = [
    { key: "id", label: "ID" },
    { key: "zone", label: "Zone" },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "lastServiced", label: "Last serviced" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader
        title="Fixtures"
        subtitle={`${lights.length} in database`}
        right={<HeaderIconButton onClick={onAddFixture} Icon={Plus} label="Add" />}
      />
      <div style={{ padding: "12px 18px 10px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10, padding: "9px 12px" }}>
          <Search size={14} color={COLOR.textTertiary} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ID, zone, or type"
            style={{ background: "none", border: "none", outline: "none", color: COLOR.textPrimary, fontSize: 13.5, fontFamily: "Inter, sans-serif", width: "100%" }}
          />
          {query && <X size={13} color={COLOR.textTertiary} onClick={() => setQuery("")} style={{ cursor: "pointer" }} />}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
          <div style={{ display: "flex", gap: 6, overflowX: "auto", flex: 1 }}>
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 999, flexShrink: 0,
                  fontFamily: "Inter, sans-serif",
                  background: filter === f.key ? COLOR.amber : COLOR.surface,
                  color: filter === f.key ? "#1A1400" : COLOR.textSecondary,
                  border: `1px solid ${filter === f.key ? COLOR.amber : COLOR.border}`,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 999, flexShrink: 0,
              fontFamily: "Inter, sans-serif", background: COLOR.surface, color: COLOR.textSecondary,
              border: `1px solid ${COLOR.border}`, outline: "none",
            }}
          >
            {sortOptions.map((o) => (
              <option key={o.key} value={o.key}>Sort: {o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 18px 18px" }}>
        {sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "40px 10px", color: COLOR.textTertiary, fontSize: 13, fontFamily: "Inter, sans-serif" }}>
            No fixtures match this search.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map((l) => (
            <button key={l.id} onClick={() => onOpenLight(l.id)} style={{ textAlign: "left", background: COLOR.surface, border: `1px solid ${COLOR.borderFaint}`, borderRadius: 12, padding: "12px 13px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, color: COLOR.textPrimary, fontWeight: 600 }}>{l.id}</span>
                <StatusPill status={l.status} size="sm" />
              </div>
              <div style={{ fontSize: 13, color: COLOR.textPrimary, fontWeight: 500, fontFamily: "Inter, sans-serif" }}>{l.type}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, color: COLOR.textTertiary, fontSize: 12, fontFamily: "Inter, sans-serif" }}>
                <MapPin size={11} /> {l.zone}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs screen
// ---------------------------------------------------------------------------
function LogsScreen({ logs, lights, onOpenLight }) {
  const [filter, setFilter] = useState("open");
  const sorted = [...logs].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const filtered = sorted.filter((l) => (filter === "open" ? !l.resolved : filter === "all" ? true : l.type.toLowerCase() === filter));

  const tabs = [
    { key: "open", label: "Open" },
    { key: "all", label: "All" },
    { key: "issue", label: "Issues" },
    { key: "maintenance", label: "Maintenance" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader title="Activity log" subtitle={`${logs.filter((l) => !l.resolved).length} open items`} />
      <div style={{ display: "flex", gap: 6, padding: "12px 18px", flexShrink: 0, overflowX: "auto" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            style={{
              fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 999, flexShrink: 0,
              fontFamily: "Inter, sans-serif",
              background: filter === t.key ? COLOR.amber : COLOR.surface,
              color: filter === t.key ? "#1A1400" : COLOR.textSecondary,
              border: `1px solid ${filter === t.key ? COLOR.amber : COLOR.border}`,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 18px 18px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((log) => {
            const light = lights.find((l) => l.id === log.lightId);
            return (
              <button key={log.id} onClick={() => onOpenLight(log.lightId)} style={{ textAlign: "left", background: COLOR.surface, border: `1px solid ${COLOR.borderFaint}`, borderRadius: 12, padding: "12px 13px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "Inter, sans-serif" }}>{log.type}</span>
                    {!log.resolved && <span style={{ width: 5, height: 5, borderRadius: "50%", background: COLOR.amber }} />}
                  </div>
                  <span style={{ fontSize: 11, color: COLOR.textTertiary, fontFamily: "'IBM Plex Mono', monospace" }}>{timeAgo(log.ts)}</span>
                </div>
                <div style={{ fontSize: 13.5, color: COLOR.textPrimary, lineHeight: 1.4, fontFamily: "Inter, sans-serif" }}>{log.description}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
                  <span style={{ fontSize: 12, color: COLOR.textSecondary, fontFamily: "'IBM Plex Mono', monospace" }}>{log.lightId} · {light?.zone}</span>
                  <SeverityDot severity={log.severity} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Light detail screen
// ---------------------------------------------------------------------------
function LightDetailScreen({ light, logs, onBack, onReport, onEditFixture, onEditLog, justScanned }) {
  const lightLogs = logs.filter((l) => l.lightId === light.id).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const s = STATUS[light.status];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader
        title={light.id}
        subtitle={light.zone}
        onBack={onBack}
        right={<HeaderIconButton onClick={onEditFixture} Icon={Pencil} />}
      />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* hero glow card */}
        <div style={{ margin: "16px 18px 0", position: "relative", borderRadius: 16, overflow: "hidden", border: `1px solid ${COLOR.borderFaint}`, background: COLOR.surface }}>
          <div
            className={justScanned ? "lw-glow-in" : ""}
            style={{
              position: "absolute", inset: 0,
              background: `radial-gradient(circle at 50% 20%, ${s.color}22 0%, transparent 65%)`,
            }}
          />
          <div style={{ position: "relative", padding: "20px 18px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 17, fontWeight: 600, color: COLOR.textPrimary }}>{light.type}</div>
                <div style={{ fontSize: 12.5, color: COLOR.textTertiary, marginTop: 2, fontFamily: "Inter, sans-serif" }}>{light.make}</div>
              </div>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: COLOR.surfaceRaised, border: `1px solid ${s.color}44`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Zap size={20} color={s.color} strokeWidth={2} />
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <StatusPill status={light.status} />
            </div>
          </div>
        </div>

        {/* details grid */}
        <div style={{ margin: "14px 18px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <DetailField label="NFC tag" value={light.nfc} mono />
          <DetailField label="Installed" value={formatDate(light.installed)} />
          <DetailField label="Last serviced" value={formatDate(light.lastServiced)} />
          <DetailField label="Zone" value={light.zone} />
        </div>

        {/* report button */}
        <div style={{ margin: "16px 18px 0" }}>
          <button
            onClick={onReport}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: COLOR.amber, color: "#1A1400", fontWeight: 700, fontSize: 14,
              padding: "12px", borderRadius: 12, border: "none", fontFamily: "Inter, sans-serif",
            }}
          >
            <AlertTriangle size={16} /> Report a problem
          </button>
        </div>

        {/* history */}
        <div style={{ margin: "22px 18px 20px" }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10, fontFamily: "Inter, sans-serif" }}>
            History ({lightLogs.length})
          </div>
          {lightLogs.length === 0 && (
            <div style={{ color: COLOR.textTertiary, fontSize: 13, fontFamily: "Inter, sans-serif" }}>No logs recorded for this fixture yet.</div>
          )}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {lightLogs.map((log, i) => (
              <div key={log.id} style={{ display: "flex", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEVERITY[log.severity].color, marginTop: 4 }} />
                  {i < lightLogs.length - 1 && <span style={{ width: 1, flex: 1, background: COLOR.borderFaint, marginTop: 4 }} />}
                </div>
                <button
                  onClick={() => onEditLog(log.id)}
                  style={{ paddingBottom: 18, flex: 1, background: "none", border: "none", textAlign: "left", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "Inter, sans-serif" }}>{log.type}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: COLOR.textTertiary, fontFamily: "'IBM Plex Mono', monospace" }}>{formatDate(log.ts)}</span>
                      <Pencil size={10} color={COLOR.textTertiary} />
                    </span>
                  </div>
                  <div style={{ fontSize: 13.5, color: COLOR.textPrimary, marginTop: 3, lineHeight: 1.4, fontFamily: "Inter, sans-serif" }}>{log.description}</div>
                  <div style={{ fontSize: 11.5, color: COLOR.textTertiary, marginTop: 4, fontFamily: "Inter, sans-serif" }}>
                    Logged by {log.by} {!log.resolved && <span style={{ color: COLOR.amber, fontWeight: 600 }}>· open</span>}
                  </div>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailField({ label, value, mono }) {
  return (
    <div style={{ background: COLOR.surface, border: `1px solid ${COLOR.borderFaint}`, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 10.5, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "Inter, sans-serif" }}>{label}</div>
      <div style={{ fontSize: 13, color: COLOR.textPrimary, marginTop: 3, fontFamily: mono ? "'IBM Plex Mono', monospace" : "Inter, sans-serif", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report problem screen
// ---------------------------------------------------------------------------
function ReportScreen({ light, onCancel, onSubmit }) {
  const [severity, setSeverity] = useState("medium");
  const [type, setType] = useState("Issue");
  const [description, setDescription] = useState("");

  const canSubmit = description.trim().length > 3;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader title="Report a problem" subtitle={`${light.id} · ${light.zone}`} onBack={onCancel} />
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <FieldLabel>Type</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {["Issue", "Maintenance", "Inspection"].map((t) => (
            <button key={t} onClick={() => setType(t)} style={{
              flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
              background: type === t ? COLOR.surfaceRaised : COLOR.surface,
              border: `1px solid ${type === t ? COLOR.amber + "80" : COLOR.border}`,
              color: type === t ? COLOR.amber : COLOR.textSecondary,
            }}>{t}</button>
          ))}
        </div>

        <FieldLabel>Severity</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {Object.entries(SEVERITY).map(([key, val]) => (
            <button key={key} onClick={() => setSeverity(key)} style={{
              flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
              background: severity === key ? val.color + "22" : COLOR.surface,
              border: `1px solid ${severity === key ? val.color : COLOR.border}`,
              color: severity === key ? val.color : COLOR.textSecondary,
            }}>{val.label}</button>
          ))}
        </div>

        <FieldLabel>What's happening</FieldLabel>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what you're seeing — for example, flickering, no power, or unusual noise."
          rows={5}
          style={{
            width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
            padding: "11px 12px", color: COLOR.textPrimary, fontSize: 13.5, fontFamily: "Inter, sans-serif",
            resize: "none", outline: "none", boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{ padding: "14px 18px 20px", flexShrink: 0, borderTop: `1px solid ${COLOR.borderFaint}` }}>
        <button
          disabled={!canSubmit}
          onClick={() => onSubmit({ type, severity, description: description.trim() })}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: canSubmit ? COLOR.amber : COLOR.surfaceRaised,
            color: canSubmit ? "#1A1400" : COLOR.textTertiary,
            fontWeight: 700, fontSize: 14, padding: "12px", borderRadius: 12, border: "none", fontFamily: "Inter, sans-serif",
          }}
        >
          <Send size={15} /> Submit log entry
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit fixture screen
// ---------------------------------------------------------------------------
const EMPTY_FIXTURE = {
  id: "", nfc: "", zone: "", type: "", make: "",
  installed: new Date().toISOString().slice(0, 10),
  lastServiced: new Date().toISOString().slice(0, 10),
  status: "operational",
};

// Fixture IDs are assigned from a persisted counter that always starts at
// LT-0001 and counts forward from there — independent of whatever IDs
// happen to already exist (the sample data uses realistic, non-sequential
// numbers, which previously threw the "next ID" guess off). If a generated
// ID happens to already be taken, we skip forward past it.
function nextFixtureId(counter, lights) {
  let n = counter + 1;
  while (lights.some((l) => l.id.toUpperCase() === `LT-${String(n).padStart(4, "0")}`)) {
    n++;
  }
  return `LT-${String(n).padStart(4, "0")}`;
}

function FixtureFormScreen({ mode, initial, lights, fixtureCounter, onCancel, onSave, onDelete }) {
  const [form, setForm] = useState(initial || { ...EMPTY_FIXTURE, id: nextFixtureId(fixtureCounter, lights) });
  const [nfcStatus, setNfcStatus] = useState("idle"); // idle | writing | success | error
  const [nfcError, setNfcError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Core NFC (via the Capacitor plugin) only exists once this app is running
  // as the compiled native shell — not in a plain browser tab, even on
  // Safari — so we check Capacitor.isNativePlatform() and fall back to
  // manual entry everywhere else (e.g. while developing in a web preview).
  const nfcSupported = Capacitor.isNativePlatform();
  const writeListenerRef = useRef(null);

  useEffect(() => {
    return () => {
      writeListenerRef.current?.remove?.();
      CapacitorNfc.stopScanning().catch(() => {});
    };
  }, []);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function writeNfcTag() {
    if (nfcStatus === "writing") return;
    const payload = form.id.trim() || nextFixtureId(fixtureCounter, lights);
    setNfcStatus("writing");
    setNfcError("");
    try {
      const record = buildNdefTextRecord(payload);

      await new Promise(async (resolve, reject) => {
        writeListenerRef.current = await CapacitorNfc.addListener("nfcEvent", async () => {
          try {
            await CapacitorNfc.write({ allowFormat: true, records: [record] });
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        try {
          await CapacitorNfc.startScanning({ invalidateAfterFirstRead: false });
        } catch (err) {
          reject(err);
        }
      });

      set("nfc", payload);
      setNfcStatus("success");
    } catch (err) {
      const msg = nfcErrorMessage(err, "write") || "No tag found. Hold a blank, writable tag against the back of the phone and try again.";
      setNfcError(msg);
      setNfcStatus("error");
    } finally {
      writeListenerRef.current?.remove?.();
      writeListenerRef.current = null;
      CapacitorNfc.stopScanning().catch(() => {});
    }
  }

  const idTaken = mode === "add" && lights.some((l) => l.id.toLowerCase() === form.id.trim().toLowerCase());
  const canSave =
    form.id.trim().length > 0 &&
    form.zone.trim().length > 0 &&
    form.type.trim().length > 0 &&
    !idTaken;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader
        title={mode === "add" ? "Add fixture" : "Edit fixture"}
        subtitle={mode === "add" ? "New entry in the database" : form.id}
        onBack={onCancel}
      />
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <FieldLabel>Fixture ID</FieldLabel>
        <input
          value={form.id}
          disabled={mode === "edit"}
          onChange={(e) => set("id", e.target.value.toUpperCase())}
          placeholder="LT-0000"
          style={{
            width: "100%", background: mode === "edit" ? COLOR.borderFaint : COLOR.surface,
            border: `1px solid ${idTaken ? COLOR.red : COLOR.border}`, borderRadius: 10,
            padding: "10px 12px", color: mode === "edit" ? COLOR.textTertiary : COLOR.textPrimary,
            fontSize: 13.5, fontFamily: "'IBM Plex Mono', monospace", outline: "none",
            boxSizing: "border-box", marginBottom: idTaken ? 4 : 16,
          }}
        />
        {idTaken && (
          <div style={{ fontSize: 11.5, color: COLOR.red, marginBottom: 12, fontFamily: "Inter, sans-serif" }}>
            A fixture with this ID already exists.
          </div>
        )}

        <FieldLabel>NFC tag</FieldLabel>
        <div style={{ fontSize: 11.5, color: COLOR.textTertiary, marginTop: -4, marginBottom: 8, fontFamily: "Inter, sans-serif" }}>
          "Write to tag" always encodes this fixture's ID ({form.id.trim() || nextFixtureId(fixtureCounter, lights)}) onto the tag — that's the name it'll scan back to.
        </div>
        {nfcSupported ? (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={form.nfc}
                onChange={(e) => set("nfc", e.target.value)}
                placeholder="Tap Write, or enter an ID manually"
                style={{
                  flex: 1, background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                  padding: "10px 12px", color: COLOR.textPrimary, fontSize: 13.5,
                  fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box",
                }}
              />
              <button
                onClick={writeNfcTag}
                disabled={nfcStatus === "writing"}
                style={{
                  display: "flex", alignItems: "center", gap: 6, flexShrink: 0, padding: "0 14px", borderRadius: 10,
                  background: nfcStatus === "writing" ? COLOR.amber + "22" : COLOR.surfaceRaised,
                  border: `1px solid ${nfcStatus === "writing" ? COLOR.amber + "80" : COLOR.border}`,
                  color: nfcStatus === "writing" ? COLOR.amber : COLOR.textSecondary, fontSize: 12.5, fontWeight: 600,
                  fontFamily: "Inter, sans-serif",
                }}
              >
                <NfcIcon size={14} />
                {nfcStatus === "writing" ? "Hold tag…" : "Write to tag"}
              </button>
            </div>
            {nfcStatus === "writing" && (
              <div style={{ fontSize: 11.5, color: COLOR.amber, marginTop: 6, fontFamily: "Inter, sans-serif" }}>
                Hold a blank, writable tag against the back of the phone…
              </div>
            )}
            {nfcStatus === "success" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: COLOR.green, marginTop: 6, fontFamily: "Inter, sans-serif" }}>
                <CheckCircle2 size={12} /> Written to tag
              </div>
            )}
            {nfcStatus === "error" && (
              <div style={{ fontSize: 11.5, color: COLOR.red, marginTop: 6, fontFamily: "Inter, sans-serif" }}>
                {nfcError}
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <input
              value={form.nfc}
              onChange={(e) => set("nfc", e.target.value)}
              placeholder="Enter tag ID manually"
              style={{
                width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                padding: "10px 12px", color: COLOR.textPrimary, fontSize: 13.5,
                fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 11.5, color: COLOR.textTertiary, marginTop: 6, fontFamily: "Inter, sans-serif" }}>
              Writing to NFC tags needs the installed app (not a browser tab). Enter the tag ID by hand for now; it'll still scan correctly once written from the native app.
            </div>
          </div>
        )}

        <FieldLabel>Zone / location</FieldLabel>
        <input
          value={form.zone}
          onChange={(e) => set("zone", e.target.value)}
          placeholder="e.g. Warehouse Aisle 3"
          style={{
            width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
            padding: "10px 12px", color: COLOR.textPrimary, fontSize: 13.5, fontFamily: "Inter, sans-serif",
            outline: "none", boxSizing: "border-box", marginBottom: 16,
          }}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div>
            <FieldLabel>Fixture type</FieldLabel>
            <input
              value={form.type}
              onChange={(e) => set("type", e.target.value)}
              placeholder="LED High-Bay 150W"
              style={{
                width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                padding: "10px 12px", color: COLOR.textPrimary, fontSize: 13, fontFamily: "Inter, sans-serif",
                outline: "none", boxSizing: "border-box",
              }}
            />
          </div>
          <div>
            <FieldLabel>Manufacturer</FieldLabel>
            <input
              value={form.make}
              onChange={(e) => set("make", e.target.value)}
              placeholder="Lumina Industrial"
              style={{
                width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                padding: "10px 12px", color: COLOR.textPrimary, fontSize: 13, fontFamily: "Inter, sans-serif",
                outline: "none", boxSizing: "border-box",
              }}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div>
            <FieldLabel>Installed</FieldLabel>
            <input
              type="date"
              value={form.installed}
              onChange={(e) => set("installed", e.target.value)}
              style={{
                width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                padding: "9px 10px", color: COLOR.textPrimary, fontSize: 12.5, fontFamily: "Inter, sans-serif",
                outline: "none", boxSizing: "border-box", colorScheme: "dark",
              }}
            />
          </div>
          <div>
            <FieldLabel>Last serviced</FieldLabel>
            <input
              type="date"
              value={form.lastServiced}
              onChange={(e) => set("lastServiced", e.target.value)}
              style={{
                width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
                padding: "9px 10px", color: COLOR.textPrimary, fontSize: 12.5, fontFamily: "Inter, sans-serif",
                outline: "none", boxSizing: "border-box", colorScheme: "dark",
              }}
            />
          </div>
        </div>

        <FieldLabel>Status</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {Object.entries(STATUS).map(([key, val]) => (
            <button
              key={key}
              onClick={() => set("status", key)}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 999,
                fontSize: 12, fontWeight: 600, fontFamily: "Inter, sans-serif",
                background: form.status === key ? val.color + "22" : COLOR.surface,
                border: `1px solid ${form.status === key ? val.color : COLOR.border}`,
                color: form.status === key ? val.color : COLOR.textSecondary,
              }}
            >
              <val.Icon size={12} /> {val.label}
            </button>
          ))}
        </div>

        {mode === "edit" && (
          <div style={{ marginTop: 26, paddingTop: 18, borderTop: `1px solid ${COLOR.borderFaint}` }}>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  background: "none", color: COLOR.red, fontWeight: 600, fontSize: 13,
                  padding: "10px", borderRadius: 10, border: `1px solid ${COLOR.red}44`, fontFamily: "Inter, sans-serif",
                }}
              >
                <Trash2 size={14} /> Delete fixture
              </button>
            ) : (
              <div style={{ background: COLOR.red + "14", border: `1px solid ${COLOR.red}44`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 12.5, color: COLOR.textPrimary, marginBottom: 10, fontFamily: "Inter, sans-serif" }}>
                  Delete {form.id} and its full log history? This can't be undone.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    style={{ flex: 1, padding: "8px", borderRadius: 8, background: COLOR.surface, border: `1px solid ${COLOR.border}`, color: COLOR.textSecondary, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onDelete(form.id)}
                    style={{ flex: 1, padding: "8px", borderRadius: 8, background: COLOR.red, border: "none", color: "#2A0A0A", fontSize: 12.5, fontWeight: 700, fontFamily: "Inter, sans-serif" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ padding: "14px 18px 20px", flexShrink: 0, borderTop: `1px solid ${COLOR.borderFaint}` }}>
        <button
          disabled={!canSave}
          onClick={() => onSave({ ...form, id: form.id.trim() })}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: canSave ? COLOR.amber : COLOR.surfaceRaised,
            color: canSave ? "#1A1400" : COLOR.textTertiary,
            fontWeight: 700, fontSize: 14, padding: "12px", borderRadius: 12, border: "none", fontFamily: "Inter, sans-serif",
          }}
        >
          <Check size={15} /> {mode === "add" ? "Add fixture" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit log entry screen
// ---------------------------------------------------------------------------
function EditLogScreen({ log, light, onCancel, onSave, onDelete }) {
  const [type, setType] = useState(log.type);
  const [severity, setSeverity] = useState(log.severity);
  const [description, setDescription] = useState(log.description);
  const [resolved, setResolved] = useState(log.resolved);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canSave = description.trim().length > 3;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ScreenHeader title="Edit log entry" subtitle={`${light?.id ?? log.lightId} · ${formatDate(log.ts)}`} onBack={onCancel} />
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        <FieldLabel>Type</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {["Issue", "Maintenance", "Inspection"].map((t) => (
            <button key={t} onClick={() => setType(t)} style={{
              flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
              background: type === t ? COLOR.surfaceRaised : COLOR.surface,
              border: `1px solid ${type === t ? COLOR.amber + "80" : COLOR.border}`,
              color: type === t ? COLOR.amber : COLOR.textSecondary,
            }}>{t}</button>
          ))}
        </div>

        <FieldLabel>Severity</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {Object.entries(SEVERITY).map(([key, val]) => (
            <button key={key} onClick={() => setSeverity(key)} style={{
              flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
              background: severity === key ? val.color + "22" : COLOR.surface,
              border: `1px solid ${severity === key ? val.color : COLOR.border}`,
              color: severity === key ? val.color : COLOR.textSecondary,
            }}>{val.label}</button>
          ))}
        </div>

        <FieldLabel>Description</FieldLabel>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          style={{
            width: "100%", background: COLOR.surface, border: `1px solid ${COLOR.border}`, borderRadius: 10,
            padding: "11px 12px", color: COLOR.textPrimary, fontSize: 13.5, fontFamily: "Inter, sans-serif",
            resize: "none", outline: "none", boxSizing: "border-box", marginBottom: 16,
          }}
        />

        <FieldLabel>Status</FieldLabel>
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <button onClick={() => setResolved(false)} style={{
            flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
            background: !resolved ? COLOR.amber + "22" : COLOR.surface,
            border: `1px solid ${!resolved ? COLOR.amber : COLOR.border}`,
            color: !resolved ? COLOR.amber : COLOR.textSecondary,
          }}>Open</button>
          <button onClick={() => setResolved(true)} style={{
            flex: 1, padding: "8px 0", borderRadius: 9, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
            background: resolved ? COLOR.green + "22" : COLOR.surface,
            border: `1px solid ${resolved ? COLOR.green : COLOR.border}`,
            color: resolved ? COLOR.green : COLOR.textSecondary,
          }}>Resolved</button>
        </div>

        <div style={{ marginTop: 26, paddingTop: 18, borderTop: `1px solid ${COLOR.borderFaint}` }}>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                background: "none", color: COLOR.red, fontWeight: 600, fontSize: 13,
                padding: "10px", borderRadius: 10, border: `1px solid ${COLOR.red}44`, fontFamily: "Inter, sans-serif",
              }}
            >
              <Trash2 size={14} /> Delete entry
            </button>
          ) : (
            <div style={{ background: COLOR.red + "14", border: `1px solid ${COLOR.red}44`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12.5, color: COLOR.textPrimary, marginBottom: 10, fontFamily: "Inter, sans-serif" }}>
                Delete this log entry? This can't be undone.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setConfirmDelete(false)}
                  style={{ flex: 1, padding: "8px", borderRadius: 8, background: COLOR.surface, border: `1px solid ${COLOR.border}`, color: COLOR.textSecondary, fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif" }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => onDelete(log.id)}
                  style={{ flex: 1, padding: "8px", borderRadius: 8, background: COLOR.red, border: "none", color: "#2A0A0A", fontSize: 12.5, fontWeight: 700, fontFamily: "Inter, sans-serif" }}
                >
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{ padding: "14px 18px 20px", flexShrink: 0, borderTop: `1px solid ${COLOR.borderFaint}` }}>
        <button
          disabled={!canSave}
          onClick={() => onSave(log.id, { type, severity, description: description.trim(), resolved })}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            background: canSave ? COLOR.amber : COLOR.surfaceRaised,
            color: canSave ? "#1A1400" : COLOR.textTertiary,
            fontWeight: 700, fontSize: 14, padding: "12px", borderRadius: 12, border: "none", fontFamily: "Inter, sans-serif",
          }}
        >
          <Check size={15} /> Save changes
        </button>
      </div>
    </div>
  );
}

function HeaderIconButton({ onClick, Icon, label, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
        background: COLOR.surfaceRaised, border: `1px solid ${danger ? COLOR.red + "55" : COLOR.border}`,
        borderRadius: 8, padding: label ? "7px 11px" : "7px", color: danger ? COLOR.red : COLOR.textPrimary,
        fontSize: 12.5, fontWeight: 600, fontFamily: "Inter, sans-serif",
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

function FieldLabel({ children }) {
  return <div style={{ fontSize: 11.5, fontWeight: 600, color: COLOR.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, fontFamily: "Inter, sans-serif" }}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Bottom nav
// ---------------------------------------------------------------------------
function BottomNav({ tab, setTab }) {
  const items = [
    { key: "scan", label: "Scan", Icon: NfcIcon },
    { key: "lights", label: "Fixtures", Icon: Home },
    { key: "logs", label: "Logs", Icon: ClipboardList },
  ];
  return (
    <div style={{ display: "flex", borderTop: `1px solid ${COLOR.borderFaint}`, background: COLOR.surface, flexShrink: 0 }}>
      {items.map(({ key, label, Icon }) => {
        const active = tab === key;
        return (
          <button key={key} onClick={() => setTab(key)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "10px 0 12px", background: "none", border: "none" }}>
            <Icon size={19} color={active ? COLOR.amber : COLOR.textTertiary} strokeWidth={active ? 2.2 : 1.8} />
            <span style={{ fontSize: 10.5, fontWeight: 600, color: active ? COLOR.amber : COLOR.textTertiary, fontFamily: "Inter, sans-serif" }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------
function fixtureFromRow(row) {
  return {
    id: row.id,
    nfc: row.nfc || "",
    zone: row.zone || "",
    type: row.type || "",
    make: row.make || "",
    installed: row.installed || "",
    lastServiced: row.last_serviced || "",
    status: row.status || "operational",
  };
}
function fixtureToRow(f) {
  return {
    id: f.id,
    nfc: f.nfc || "",
    zone: f.zone || "",
    type: f.type || "",
    make: f.make || "",
    installed: f.installed || null,
    last_serviced: f.lastServiced || null,
    status: f.status || "operational",
  };
}
function logFromRow(row) {
  return {
    id: row.id,
    lightId: row.light_id,
    type: row.type || "",
    severity: row.severity || "",
    description: row.description || "",
    by: row.by || "",
    ts: row.ts,
    resolved: !!row.resolved,
  };
}
function logToRow(l) {
  return {
    id: l.id,
    light_id: l.lightId,
    type: l.type || "",
    severity: l.severity || "",
    description: l.description || "",
    by: l.by || "",
    ts: l.ts || new Date().toISOString(),
    resolved: !!l.resolved,
  };
}

async function loadStore(key, fallback) {
  try {
    if (key === "lights") {
      const { data, error } = await supabase.from("fixtures").select("*");
      if (error) throw error;
      if (!data || data.length === 0) return fallback;
      return data.map(fixtureFromRow);
    }
    if (key === "logs") {
      const { data, error } = await supabase.from("logs").select("*").order("ts", { ascending: false });
      if (error) throw error;
      if (!data || data.length === 0) return fallback;
      return data.map(logFromRow);
    }
    if (key === "fixture-counter") {
      const { data, error } = await supabase.from("meta").select("value").eq("key", "fixture-counter").maybeSingle();
      if (error) throw error;
      return data ? data.value : fallback;
    }
    return fallback;
  } catch (err) {
    console.error(`Failed to load ${key} from Supabase`, err);
    return fallback;
  }
}

async function saveStore(key, value) {
  try {
    if (key === "lights") {
      await supabase.from("fixtures").delete().neq("id", "__none__");
      if (value.length > 0) {
        const { error } = await supabase.from("fixtures").insert(value.map(fixtureToRow));
        if (error) throw error;
      }
      return;
    }
    if (key === "logs") {
      await supabase.from("logs").delete().neq("id", "__none__");
      if (value.length > 0) {
        const { error } = await supabase.from("logs").insert(value.map(logToRow));
        if (error) throw error;
      }
      return;
    }
    if (key === "fixture-counter") {
      const { error } = await supabase.from("meta").upsert({ key: "fixture-counter", value });
      if (error) throw error;
      return;
    }
  } catch (err) {
    console.error(`Failed to save ${key} to Supabase`, err);
  }
}

export default function LightWatchApp() {
  const [lights, setLights] = useState(INITIAL_LIGHTS);
  const [logs, setLogs] = useState(INITIAL_LOGS);
  const [fixtureCounter, setFixtureCounter] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [tab, setTab] = useState("scan");
  const [screen, setScreen] = useState("main"); // main | detail | report | addFixture | editFixture | editLog
  const [selectedId, setSelectedId] = useState(null);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [justScanned, setJustScanned] = useState(false);
  const [scanError, setScanError] = useState("");
  const scanAbort = useRef(null);

  // Core NFC only exists once this app is running as the compiled native
  // shell (via Capacitor) — same check used on the fixture-write screen.
  const nfcSupported = Capacitor.isNativePlatform();

  // Kept in a ref so the nfcTagScanned callback (set up once per scan) always
  // sees the latest fixtures instead of whatever was current when scan()
  // was called.
  const lightsRef = useRef(lights);
  useEffect(() => {
    lightsRef.current = lights;
  }, [lights]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    function openFromUrl(url) {
      let tagId = "";
      try {
        const parsed = new URL(url);
        tagId = parsed.searchParams.get("id") || "";
      } catch {
        return;
      }
      if (!tagId) return;

      const match = lightsRef.current.find(
        (l) => l.nfc.trim().toUpperCase() === tagId.toUpperCase() || l.id.toUpperCase() === tagId.toUpperCase()
      );
      if (match) {
        setSelectedId(match.id);
        setScreen("detail");
        setJustScanned(true);
        setTimeout(() => setJustScanned(false), 900);
      } else {
        setScanError(`Tag reads "${tagId}" — no fixture in the database has that tag.`);
      }
    }

    const listenerPromise = CapacitorApp.addListener("appUrlOpen", (data) => {
      openFromUrl(data.url);
    });

    CapacitorApp.getLaunchUrl().then((result) => {
      if (result?.url) openFromUrl(result.url);
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, []);

  useEffect(() => {
    return () => {
      scanAbort.current?.remove?.();
      CapacitorNfc.stopScanning().catch(() => {});
    };
  }, []);

  // Load fixtures/logs/ID counter from persistent storage on first mount.
  // If nothing's been saved yet (first run), start from a clean, empty
  // database with the counter at 0 (so the first fixture you add becomes
  // LT-0001).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [storedLights, storedLogs, storedCounter] = await Promise.all([
          loadStore("lights", null),
          loadStore("logs", null),
          loadStore("fixture-counter", null),
        ]);
        if (cancelled) return;
        if (storedLights === null) {
          setLights(INITIAL_LIGHTS);
          saveStore("lights", INITIAL_LIGHTS);
        } else {
          setLights(storedLights);
        }
        if (storedLogs === null) {
          setLogs(INITIAL_LOGS);
          saveStore("logs", INITIAL_LOGS);
        } else {
          setLogs(storedLogs);
        }
        if (storedCounter === null) {
          setFixtureCounter(0);
          saveStore("fixture-counter", 0);
        } else {
          setFixtureCounter(storedCounter);
        }
      } catch (err) {
        console.error("Failed to load saved data", err);
        if (!cancelled) setSyncError(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleScan() {
    if (scanning) return;
    setScanError("");

    if (!nfcSupported) {
      setScanError("NFC scanning needs the installed app — this can't read tags in a plain web browser.");
      return;
    }

    setScanning(true);
    try {
      // The listener stays registered for the life of the scan session; it
      // fires once per tag tap. We tear the session down as soon as we get
      // a reading (successful or not), mirroring the old single-shot scan.
      scanAbort.current = await CapacitorNfc.addListener("nfcEvent", (event) => {
        let tagId = "";
        try {
          const records = event?.tag?.ndefMessage || [];
          tagId = decodeNdefTextRecord(records[0]);
        } catch {
          tagId = "";
        }

        CapacitorNfc.stopScanning().catch(() => {});
        scanAbort.current?.remove?.();
        scanAbort.current = null;
        setScanning(false);

        const match = lightsRef.current.find(
          (l) => l.nfc.trim().toUpperCase() === tagId.toUpperCase() || l.id.toUpperCase() === tagId.toUpperCase()
        );
        if (match) {
          setJustScanned(true);
          setSelectedId(match.id);
          setScreen("detail");
          setTimeout(() => setJustScanned(false), 900);
        } else if (tagId) {
          setScanError(`Tag reads "${tagId}" — no fixture in the database has that tag. Write this tag to a fixture from Add/Edit Fixture, or check the ID.`);
        } else {
          setScanError("Couldn't read that tag's data. Try again.");
        }
      });

      await CapacitorNfc.startScanning();
    } catch (err) {
      setScanning(false);
      scanAbort.current?.remove?.();
      scanAbort.current = null;
      const msg = nfcErrorMessage(err, "scan");
      if (msg) setScanError(msg);
    }
  }

  function openLight(id) {
    setSelectedId(id);
    setJustScanned(false);
    setScreen("detail");
  }

  function submitLog({ type, severity, description }) {
    const newLog = {
      id: `LG-${Math.floor(3300 + Math.random() * 700)}`,
      lightId: selectedId,
      type,
      severity,
      description,
      by: "You",
      ts: new Date().toISOString(),
      resolved: false,
    };
    const next = [newLog, ...logs];
    setLogs(next);
    saveStore("logs", next);
    setScreen("detail");
  }

  function addFixture(newLight) {
    const next = [newLight, ...lights];
    setLights(next);
    saveStore("lights", next);

    // Keep the ID counter moving forward from whatever number was just
    // used, so the next fixture continues the LT-0001, LT-0002... sequence
    // even if this one's ID was hand-edited.
    const usedNum = parseInt((newLight.id.match(/\d+/) || [0])[0], 10);
    if (!isNaN(usedNum) && usedNum > fixtureCounter) {
      setFixtureCounter(usedNum);
      saveStore("fixture-counter", usedNum);
    }

    setSelectedId(newLight.id);
    setScreen("detail");
  }

  function saveFixtureEdits(updated) {
    const next = lights.map((l) => (l.id === updated.id ? { ...l, ...updated } : l));
    setLights(next);
    saveStore("lights", next);
    setScreen("detail");
  }

  function deleteFixture(id) {
    const nextLights = lights.filter((l) => l.id !== id);
    const nextLogs = logs.filter((l) => l.lightId !== id);
    setLights(nextLights);
    setLogs(nextLogs);
    saveStore("lights", nextLights);
    saveStore("logs", nextLogs);
    setSelectedId(null);
    setScreen("main");
    setTab("lights");
  }

  function saveLogEdits(logId, updates) {
    const next = logs.map((l) => (l.id === logId ? { ...l, ...updates } : l));
    setLogs(next);
    saveStore("logs", next);
    setScreen("detail");
  }

  function deleteLogEntry(logId) {
    const next = logs.filter((l) => l.id !== logId);
    setLogs(next);
    saveStore("logs", next);
    setScreen("detail");
  }

  const selectedLight = lights.find((l) => l.id === selectedId);
  const selectedLog = logs.find((l) => l.id === selectedLogId);

  return (
    <div style={{ minHeight: "100vh", background: COLOR.base, display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        html, body, #root { height: 100%; margin: 0; }
        input::placeholder, textarea::placeholder { color: ${COLOR.textTertiary}; }
        .lw-pulse-ring {
          position: absolute; width: 172px; height: 172px; border-radius: 50%;
          border: 1.5px solid ${COLOR.amber};
          animation: lw-pulse 1.6s cubic-bezier(0.2,0.6,0.4,1) infinite;
          opacity: 0;
        }
        @keyframes lw-pulse {
          0% { transform: scale(0.55); opacity: 0.7; }
          100% { transform: scale(1); opacity: 0; }
        }
        .lw-glow-in { animation: lw-glow 0.9s ease-out; }
        @keyframes lw-glow {
          0% { opacity: 0; }
          30% { opacity: 1; }
          100% { opacity: 1; }
        }
        .lw-scrollable::-webkit-scrollbar { width: 0px; }
      `}</style>

      <div style={{ flex: 1, minHeight: "100vh", background: COLOR.base, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: "Inter, sans-serif" }}>
          {!loaded ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.textSecondary, fontSize: 13 }}>
              Loading saved fixtures…
            </div>
          ) : (
          <>
          {syncError && (
            <div style={{ padding: "8px 14px", background: COLOR.amber + "1A", borderBottom: `1px solid ${COLOR.amber}33`, color: COLOR.amber, fontSize: 11, fontFamily: "Inter, sans-serif", flexShrink: 0 }}>
              Couldn't reach saved data — showing sample data for this session, changes won't sync.
            </div>
          )}
          {screen === "main" && tab === "scan" && (
            <ScanScreen lights={lights} logs={logs} onOpenLight={openLight} scanning={scanning} onScan={handleScan} nfcSupported={nfcSupported} scanError={scanError} />
          )}
          {screen === "main" && tab === "lights" && (
            <LightsScreen lights={lights} onOpenLight={openLight} onAddFixture={() => setScreen("addFixture")} />
          )}
          {screen === "main" && tab === "logs" && (
            <LogsScreen
              logs={logs}
              lights={lights}
              onOpenLight={(id) => {
                openLight(id);
              }}
            />
          )}
          {screen === "detail" && selectedLight && (
            <LightDetailScreen
              light={selectedLight}
              logs={logs}
              onBack={() => setScreen("main")}
              onReport={() => setScreen("report")}
              onEditFixture={() => setScreen("editFixture")}
              onEditLog={(logId) => {
                setSelectedLogId(logId);
                setScreen("editLog");
              }}
              justScanned={justScanned}
            />
          )}
          {screen === "report" && selectedLight && (
            <ReportScreen light={selectedLight} onCancel={() => setScreen("detail")} onSubmit={submitLog} />
          )}
          {screen === "addFixture" && (
            <FixtureFormScreen
              mode="add"
              initial={null}
              lights={lights}
              fixtureCounter={fixtureCounter}
              onCancel={() => setScreen("main")}
              onSave={addFixture}
            />
          )}
          {screen === "editFixture" && selectedLight && (
            <FixtureFormScreen
              mode="edit"
              initial={selectedLight}
              lights={lights}
              fixtureCounter={fixtureCounter}
              onCancel={() => setScreen("detail")}
              onSave={saveFixtureEdits}
              onDelete={deleteFixture}
            />
          )}
          {screen === "editLog" && selectedLog && (
            <EditLogScreen
              log={selectedLog}
              light={lights.find((l) => l.id === selectedLog.lightId)}
              onCancel={() => setScreen("detail")}
              onSave={saveLogEdits}
              onDelete={deleteLogEntry}
            />
          )}
          </>
          )}
        </div>

        {loaded && screen === "main" && <BottomNav tab={tab} setTab={setTab} />}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import AuthButton from "@/components/AuthButton";
import Tabs from "@/components/Tabs";
import Chat from "@/components/Chat";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import styles from "./dashboard.module.css";

const TABS = [
  { id: "overview", label: "overview" },
  { id: "settings", label: "settings" },
];

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState("overview");
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className={styles.page}>
      {/* Toolbar */}
      <div className={styles.header}>
        <a href="/" className={styles.logo}>
          <span className={styles.logoAccent}>Spark</span>Stack
        </a>
        <div className={styles.spacer} />
        <button
          className={styles.chatBtn}
          onClick={() => setChatOpen((v) => !v)}
          style={chatOpen ? { background: "#f59e0b", borderColor: "#f59e0b", color: "#000" } : undefined}
        >
          <AutoAwesomeIcon sx={{ fontSize: 16 }} />
          <span>AI Chat</span>
        </button>
        <AuthButton />
        <span className={styles.version}>v0.1.0</span>
      </div>

      {/* Tabs */}
      <Tabs tabs={TABS} activeId={activeTab} onTabChange={setActiveTab} />

      {/* Content */}
      <div className={styles.main}>
        <div className={styles.content}>
          {activeTab === "overview" && (
            <>
              {/* About section */}
              <div className={styles.about}>
                <div className={styles.comment}>// welcome</div>
                <p>
                  This is the SparkStack project template. It includes the full
                  infrastructure stack: Next.js 16, React 19, PostgreSQL with
                  Drizzle ORM, MinIO object storage, Better-Auth with Google
                  OAuth, and the SparkBench dark IDE aesthetic.
                </p>
                <div className={styles.comment}>// stack</div>
                <div className={styles.tagRow}>
                  {["Next.js 16", "React 19", "TypeScript", "Tailwind", "PostgreSQL", "Drizzle", "MinIO", "Better-Auth", "Docker", "MUI", "Anthropic", "OpenRouter", "Agent SDK"].map((s) => (
                    <span key={s} className={styles.tag}>{s}</span>
                  ))}
                </div>
              </div>

              {/* Quick start */}
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>quick start</span>
              </div>

              <div className={styles.guide}>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>1</span>
                  <div>
                    <div className={styles.guideLabel}>Copy environment</div>
                    <code className={styles.code}>cp .env.example .env</code>
                  </div>
                </div>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>2</span>
                  <div>
                    <div className={styles.guideLabel}>Start services</div>
                    <code className={styles.code}>docker compose up -d</code>
                  </div>
                </div>
                <div className={styles.guideStep}>
                  <span className={styles.guideNum}>3</span>
                  <div>
                    <div className={styles.guideLabel}>Install &amp; run</div>
                    <code className={styles.code}>npm install && npm run db:push && npm run dev</code>
                  </div>
                </div>
              </div>

              {/* Features section */}
              <div className={styles.sectionHeader}>
                <span className={styles.sectionTitle}>included</span>
              </div>

              <div className={styles.featureList}>
                <FeatureRow icon="db" title="PostgreSQL + Drizzle ORM" desc="Schema in lib/db/schema.ts, push with npm run db:push" />
                <FeatureRow icon="auth" title="Google OAuth" desc="Better-Auth wired to Drizzle, add providers in lib/auth.ts" />
                <FeatureRow icon="s3" title="MinIO Object Storage" desc="S3-compatible file storage, helpers in lib/storage.ts" />
                <FeatureRow icon="docker" title="Docker Production Deploy" desc="Multi-stage Dockerfile, docker-compose.prod.yml ready" />
                <FeatureRow icon="ai" title="AI Chat (3 providers)" desc="Anthropic API, OpenRouter, or Claude Agent SDK with MCP tools" />
                <FeatureRow icon="ui" title="Dark IDE Aesthetic" desc="SparkBench-style dark theme with MUI + Tailwind" />
              </div>
            </>
          )}

          {activeTab === "settings" && (
            <div className={styles.empty}>
              settings panel — add your app config here
            </div>
          )}
        </div>
      </div>

      {/* AI Chat panel — slides in from right */}
      {chatOpen && (
        <div className={styles.chatPanel}>
          <Chat
            open={chatOpen}
            onClose={() => setChatOpen(false)}
            suggestions={[
              "Help me get started",
              "Explain the project structure",
              "Add a new API route",
              "Write a database query",
            ]}
          />
        </div>
      )}
    </div>
  );
}

function FeatureRow({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  const icons: Record<string, string> = { db: "//", auth: ">>", s3: "[]", docker: "<>", ai: "**", ui: "##" };
  return (
    <div className={styles.featureRow}>
      <span className={styles.featureIcon}>{icons[icon] || "//"}</span>
      <div>
        <div className={styles.featureName}>{title}</div>
        <div className={styles.featureDesc}>{desc}</div>
      </div>
    </div>
  );
}

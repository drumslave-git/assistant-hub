"use client";

import { Save } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  Fab,
  Field,
  Input,
  Select,
  Switch,
  Tabs,
  type BadgeTone,
  type TabItem,
} from "@/components/ui";
import type { Backend } from "@/features/backends/server/schema";
import { cn } from "@/lib/cn";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { ProbeReport, Settings } from "../server/schema";
import {
  readError,
  useBackendModels,
  useProbe,
  useSecretField,
  type ProbeState,
} from "./connection";
import { ChangePasswordSection } from "./ChangePasswordSection";
import { RoleSection, type RoleSectionLabels } from "./RoleSection";

/**
 * Bot settings editor. Client Component with one tab per concern: **Models**,
 * Telegram, General, Integrations, Security.
 *
 * The LLM configuration is per **role** — Chat (the main model every reply runs
 * on, which must support thinking and tool calls), Embeddings, Images, Speech,
 * Audio (STT), Vision, Browser agent, Classifiers (the per-message checks) and
 * Background jobs (the nightly passes) — and every role picks a backend from
 * the shared catalog (managed on the Backends page) plus a model through a
 * searchable select fed by that backend's live model list. A role without its
 * own backend uses the chat backend; audio/vision/browser/classifier/background
 * additionally fall back to the chat model when none is picked ("main by
 * default").
 *
 * All nine roles live on **one** tab as stacked sections (user decision,
 * 2026-08-14) rather than nine tabs of their own. They are not nine independent
 * settings: eight of them inherit the chat backend, so repointing chat can
 * invalidate a model selection belonging to a role the operator is not looking
 * at. On separate tabs that consequence was real but invisible — the warning
 * existed, on a tab nobody had a reason to open. Side by side, the effect of a
 * chat change shows up where it happens, and {@link SettingsForm.staleRoles}
 * additionally names every affected role at the top of the tab.
 *
 * One Save button — the floating {@link Fab} — persists every changed field
 * regardless of the active tab, which is the reason it floats: the form is five
 * tabs and nine role cards long, and an inline button at the bottom of it is a
 * scroll away from most of what it saves. Secrets are write-only — shown as
 * "configured" but their values never leave the server.
 *
 * Only changed fields are sent, which the server relies on: a model absent
 * from the patch is a *stored* selection, and when the same patch repoints the
 * backend serving it, the server verifies it against the new backend's model
 * list and clears it if it is not served. The form covers the case that check
 * cannot see — a selection stale against the *unchanged* backend: a
 * successfully listed backend that does not serve the stored model flags it in
 * its section, and the save sends it as null. Either way, everything cleared is
 * named on the Models tab, where those roles are — the floating button carries
 * only the verdict.
 */

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One LLM role section, as data. Every axis here is a real difference between
 * the roles; anything not listed is shared behaviour and is decided once in
 * {@link SettingsForm.roleBlock}, so the sections cannot drift apart.
 */
interface RoleTabSpec {
  /** Section id (anchor target), also the field-id prefix ("embedding" → `embeddingModel`). */
  id: string;
  label: string;
  role: RoleConfig;
  labels: RoleSectionLabels;
  /**
   * Whether an empty model means "run on the chat model" rather than "this
   * capability is off". It decides the placeholder's promise and whether the
   * role can be tested without a model of its own.
   */
  fallsBackToChat?: boolean;
  /** Free-text model entry — endpoints whose ids cannot be listed. */
  freeText?: boolean;
  /** Whether the fetched model list can prove this selection stale (default true). */
  listed?: boolean;
  /** Chat has no "same backend as chat" option; every other role does. */
  inherit?: boolean;
  probe: {
    state: ProbeState<ProbeReport>;
    reset: () => void;
    run: () => void;
    /** Extra condition blocking the test (chat needs a backend selected). */
    disabled?: boolean;
  };
  /** Role-specific extra fields, e.g. audio's transcription mode. */
  children?: ReactNode;
}

/** One role's backend + model selection state. */
function useRoleConfig(initial: { backendId: string | null; model: string | null }) {
  const [backendId, setBackendId] = useState(initial.backendId);
  const [model, setModel] = useState(initial.model ?? "");
  return {
    backendId,
    model,
    setBackendId,
    setModel,
    applySaved(saved: { backendId: string | null; model: string | null }) {
      setBackendId(saved.backendId);
      setModel(saved.model ?? "");
    },
  };
}

type RoleConfig = ReturnType<typeof useRoleConfig>;

/** One rendered role section plus the bits the Models tab's summary reads. */
interface RoleBlock {
  spec: RoleTabSpec;
  /** The configured model is provably not served by this role's effective backend. */
  stale: boolean;
  content: ReactNode;
}

/**
 * What a role is currently set to, as the badge on its card header — the line
 * that makes nine stacked cards scannable without opening each one.
 *
 * The three tones carry the distinction that matters: `primary` is an explicit
 * choice, `neutral` is a role running on the chat model or deliberately off, and
 * `warning` is the one state needing action.
 */
function roleSummary(block: RoleBlock): { text: string; tone: BadgeTone } {
  const model = block.spec.role.model.trim();
  if (block.stale) return { text: `${model} — not served`, tone: "warning" };
  if (model) return { text: model, tone: "primary" };
  if (block.spec.fallsBackToChat) return { text: "Chat model", tone: "neutral" };
  // Chat is the one role that neither falls back nor is optional.
  if (block.spec.inherit === false) return { text: "No model selected", tone: "warning" };
  return { text: "Off", tone: "neutral" };
}

export function SettingsForm({
  initial,
  backends = [],
  initialBackendModels = {},
}: {
  initial: Settings;
  /** The saved backend catalog the role selects offer. */
  backends?: Backend[];
  /** Models preloaded server-side per backend id, so dropdowns work on open. */
  initialBackendModels?: Record<string, string[]>;
}) {
  const router = useRouter();

  // Role configurations.
  const chat = useRoleConfig({ backendId: initial.chatBackendId, model: initial.model });
  const emb = useRoleConfig({
    backendId: initial.embeddingBackendId,
    model: initial.embeddingModel,
  });
  const img = useRoleConfig({ backendId: initial.imageBackendId, model: initial.imageModel });
  const spc = useRoleConfig({ backendId: initial.speechBackendId, model: initial.speechModel });
  const aud = useRoleConfig({ backendId: initial.audioBackendId, model: initial.audioModel });
  const vis = useRoleConfig({ backendId: initial.visionBackendId, model: initial.visionModel });
  const brw = useRoleConfig({ backendId: initial.browserBackendId, model: initial.browserModel });
  const cls = useRoleConfig({
    backendId: initial.classifierBackendId,
    model: initial.classifierModel,
  });
  const bgd = useRoleConfig({
    backendId: initial.backgroundBackendId,
    model: initial.backgroundModel,
  });
  const [speechVoice, setSpeechVoice] = useState(initial.speechVoice ?? "");
  const [audioTranscriptionMode, setAudioTranscriptionMode] = useState(
    initial.audioTranscriptionMode,
  );

  // Core operational settings.
  const tavilyKey = useSecretField(initial.webSearchConfigured);
  const [maintenanceMode, setMaintenanceMode] = useState(initial.maintenanceModeEnabled);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyJobsRunTime, setDailyJobsRunTime] = useState(initial.dailyJobsRunTime);
  const [loopGuardTurns, setLoopGuardTurns] = useState(String(initial.assistantLoopGuardTurns));
  const [browserDownloadLimitGb, setBrowserDownloadLimitGb] = useState(
    String(initial.browserDownloadLimitGb),
  );

  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // Model selections cleared on the last save (client-flagged stale plus
  // whatever the server cleared after a repoint) — shown next to the Save
  // button, since the roles they belong to live on other tabs.
  const [clearedOnSave, setClearedOnSave] = useState<string[]>([]);
  // Controlled so the global Save row can step aside on the Security tab, whose
  // password change has its own endpoint and button.
  const [activeTab, setActiveTab] = useState("models");

  // Per-backend model lists, preloaded for saved backends and fetched on
  // demand for any backend a role gets pointed at afterwards.
  const modelCache = useBackendModels(initialBackendModels);

  /** The backend a role actually talks to: its own, else the chat one. */
  const effectiveBackendId = (role: RoleConfig) => role.backendId ?? chat.backendId;

  const roleList = [chat, emb, img, spc, aud, vis, brw];
  const effectiveIds = roleList.map(effectiveBackendId);
  useEffect(() => {
    for (const id of effectiveIds) modelCache.ensure(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIds.join("|")]);

  // Probes — one per role, every one reporting the same {@link ProbeReport}.
  const chatProbe = useProbe<ProbeReport>("/api/settings/test-chat");
  const embedProbe = useProbe<ProbeReport>("/api/settings/test-embeddings");
  const imageProbe = useProbe<ProbeReport>("/api/settings/test-images");
  const speechProbe = useProbe<ProbeReport>("/api/settings/test-speech");
  const audioProbe = useProbe<ProbeReport>("/api/settings/test-audio");
  const visionProbe = useProbe<ProbeReport>("/api/settings/test-vision");
  const browserProbe = useProbe<ProbeReport>("/api/settings/test-browser");
  const classifierProbe = useProbe<ProbeReport>("/api/settings/test-classifier");
  const backgroundProbe = useProbe<ProbeReport>("/api/settings/test-background");

  /** Probe body for one role: the form's current (possibly unsaved) values. */
  const roleProbeBody = (role: RoleConfig) => ({
    backendId: role.backendId,
    model: role.model.trim() === "" ? null : role.model.trim(),
  });

  /** The model-list state a role's combobox renders from. */
  const roleModels = (role: RoleConfig) => modelCache.get(effectiveBackendId(role));

  /**
   * Whether a role's selection is provably stale: its effective backend's list
   * was successfully fetched and does not contain the stored model. Audio in
   * `transcriptions` mode is exempt — whisper-class servers often list nothing,
   * so an absent listing proves nothing there. In `chat` mode the audio model
   * is an ordinary chat model the backend must list, so it is checked like the
   * rest.
   */
  const roleStale = (role: RoleConfig) => {
    const models = roleModels(role);
    return (
      models?.kind === "ok" && role.model.trim() !== "" && !models.models.includes(role.model.trim())
    );
  };

  const staleWarning = (m: string) =>
    `"${m}" is not served by the configured backend — it will be cleared on save unless you pick another.`;

  async function onSave() {
    setSave({ kind: "saving" });
    setClearedOnSave([]);

    // Changed fields only. The server depends on that: a model missing from the
    // patch is a stored selection, which it verifies (and clears) when the same
    // patch repoints the backend serving it.
    const patch: Record<string, unknown> = {};
    const roleFields = [
      { role: chat, backendKey: "chatBackendId", modelKey: "model", label: "chat model", listed: true },
      {
        role: emb,
        backendKey: "embeddingBackendId",
        modelKey: "embeddingModel",
        label: "embedding model",
        listed: true,
      },
      { role: img, backendKey: "imageBackendId", modelKey: "imageModel", label: "image model", listed: true },
      { role: spc, backendKey: "speechBackendId", modelKey: "speechModel", label: "speech model", listed: true },
      {
        role: aud,
        backendKey: "audioBackendId",
        modelKey: "audioModel",
        label: "audio model",
        listed: audioTranscriptionMode === "chat",
      },
      { role: vis, backendKey: "visionBackendId", modelKey: "visionModel", label: "vision model", listed: true },
      {
        role: brw,
        backendKey: "browserBackendId",
        modelKey: "browserModel",
        label: "browser model",
        listed: true,
      },
      {
        role: cls,
        backendKey: "classifierBackendId",
        modelKey: "classifierModel",
        label: "classifier model",
        listed: true,
      },
      {
        role: bgd,
        backendKey: "backgroundBackendId",
        modelKey: "backgroundModel",
        label: "background model",
        listed: true,
      },
    ] as const;

    const staleCleared: string[] = [];
    for (const { role, backendKey, modelKey, label, listed } of roleFields) {
      const initialBackend = initial[backendKey];
      const initialModel = initial[modelKey] ?? "";
      if (role.backendId !== initialBackend) patch[backendKey] = role.backendId;
      const trimmed = role.model.trim();
      if (trimmed !== initialModel) patch[modelKey] = trimmed === "" ? null : trimmed;
      // A selection the fetched list proves stale is cleared with the save,
      // exactly as the warning on its tab promises — the server only verifies
      // when the same patch repoints a backend, which a leftover stale against
      // an unchanged backend never triggers.
      else if (listed && roleStale(role)) {
        patch[modelKey] = null;
        staleCleared.push(label);
      }
    }

    if (audioTranscriptionMode !== initial.audioTranscriptionMode) {
      patch.audioTranscriptionMode = audioTranscriptionMode;
    }
    if (tavilyKey.dirty) patch.tavilyApiKey = tavilyKey.patchValue;
    if (speechVoice.trim() !== (initial.speechVoice ?? "")) {
      patch.speechVoice = speechVoice.trim() === "" ? null : speechVoice.trim();
    }
    if (maintenanceMode !== initial.maintenanceModeEnabled) {
      patch.maintenanceModeEnabled = maintenanceMode;
    }
    if (timezone.trim() !== initial.timezone && timezone.trim() !== "") {
      patch.timezone = timezone.trim();
    }
    if (dailyJobsRunTime.trim() !== initial.dailyJobsRunTime && dailyJobsRunTime.trim() !== "") {
      patch.dailyJobsRunTime = dailyJobsRunTime.trim();
    }
    const guardTurns = Number(loopGuardTurns);
    if (
      loopGuardTurns.trim() !== "" &&
      Number.isInteger(guardTurns) &&
      guardTurns !== initial.assistantLoopGuardTurns
    ) {
      patch.assistantLoopGuardTurns = guardTurns;
    }
    const limitGb = Number(browserDownloadLimitGb);
    if (
      Number.isInteger(limitGb) &&
      limitGb !== initial.browserDownloadLimitGb &&
      limitGb >= 1 &&
      limitGb <= 100
    ) {
      patch.browserDownloadLimitGb = limitGb;
    }

    // With every field sent changed-only, an untouched form produces an empty
    // patch, which the API rightly rejects — there is simply nothing to do.
    if (Object.keys(patch).length === 0) {
      setSave({ kind: "saved" });
      return;
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setSave({ kind: "error", message: await readError(res) });
        return;
      }
      const { data } = (await res.json()) as { data: Settings };
      // Everything cleared for staleness gets named next to the Save button.
      // Two sources: what this client cleared from its fetched lists, and a
      // stored selection we did not send that came back null (the server
      // cleared it after verifying against a repointed backend).
      const cleared: string[] = [...staleCleared];
      for (const { role, modelKey, label } of roleFields) {
        if (!(modelKey in patch) && role.model !== "" && data[modelKey] === null) {
          cleared.push(label);
        }
      }
      setClearedOnSave(cleared);
      tavilyKey.clear();
      chat.applySaved({ backendId: data.chatBackendId, model: data.model });
      emb.applySaved({ backendId: data.embeddingBackendId, model: data.embeddingModel });
      img.applySaved({ backendId: data.imageBackendId, model: data.imageModel });
      spc.applySaved({ backendId: data.speechBackendId, model: data.speechModel });
      aud.applySaved({ backendId: data.audioBackendId, model: data.audioModel });
      vis.applySaved({ backendId: data.visionBackendId, model: data.visionModel });
      brw.applySaved({ backendId: data.browserBackendId, model: data.browserModel });
      cls.applySaved({ backendId: data.classifierBackendId, model: data.classifierModel });
      bgd.applySaved({ backendId: data.backgroundBackendId, model: data.backgroundModel });
      setSpeechVoice(data.speechVoice ?? "");
      setAudioTranscriptionMode(data.audioTranscriptionMode);
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setDailyJobsRunTime(data.dailyJobsRunTime);
      setLoopGuardTurns(String(data.assistantLoopGuardTurns));
      setBrowserDownloadLimitGb(String(data.browserDownloadLimitGb));
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const chatBackend = backends.find((b) => b.id === chat.backendId) ?? null;
  const inheritLabel = chatBackend
    ? `Same backend as chat (${chatBackend.name})`
    : "Same backend as chat (not configured yet)";

  const noBackends = backends.length === 0;
  const noBackendsNote = noBackends ? (
    <p className="text-sm text-warning">
      No backends yet — add one on the Backends page first; every role here picks from that list.
    </p>
  ) : null;

  /**
   * Render one LLM role section. Everything the roles must agree on is decided
   * here, once: changing a backend (or a model, when the probe tests one)
   * clears that role's stale probe result, the model list drives the stale
   * warning, and a role whose empty model means "use the chat model" stays
   * testable without one. Per-role differences arrive as {@link RoleTabSpec}.
   */
  function roleBlock(spec: RoleTabSpec): RoleBlock {
    const { role, probe } = spec;
    const listed = spec.listed ?? true;
    return {
      spec,
      stale: listed && roleStale(role),
      content: (
        <RoleSection
          idPrefix={spec.id}
          labels={spec.labels}
          backends={backends}
          backendId={role.backendId}
          onBackendChange={(next) => {
            role.setBackendId(next);
            probe.reset();
          }}
          inheritLabel={spec.inherit === false ? null : inheritLabel}
          model={role.model}
          onModelChange={(next) => {
            role.setModel(next);
            probe.reset();
          }}
          models={roleModels(role)}
          freeTextModel={spec.freeText}
          modelWarning={listed && roleStale(role) ? staleWarning(role.model) : null}
          probe={probe.state}
          onTest={probe.run}
          testDisabled={
            probe.disabled ?? (!spec.fallsBackToChat && role.model.trim() === "")
          }
        >
          {spec.children}
        </RoleSection>
      ),
    };
  }

  const chatBlock = roleBlock({
    id: "chat",
    label: "Chat",
    role: chat,
    inherit: false,
    labels: {
      intro:
        "The main backend and model every reply runs on. Pick a model that supports thinking and tool calls — replies reason before answering and drive every tool (history search, tasks, browsing). Roles on the other tabs use this backend unless given their own, so repointing it repoints them too, and any of their model selections the new backend does not serve is cleared on save.",
      backendHint: "The chat endpoint, from the shared catalog (managed on the Backends page).",
      modelLabel: "Model",
      modelHint:
        "The chat model used for replies. It must support thinking and tool calls — the test below asks it a question and shows both the answer and the reasoning behind it.",
      modelPlaceholder: "Select a model…",
      testLabel: "Test chat",
    },
    probe: {
      state: chatProbe.state,
      reset: chatProbe.reset,
      run: () => void chatProbe.run(roleProbeBody(chat)),
      // Chat is the one role with no fallback: without a model there is
      // nothing to ask, and without a backend nowhere to ask it.
      disabled: !chat.backendId || chat.model.trim() === "",
    },
  });

  const embeddingsBlock = roleBlock({
    id: "embedding",
    label: "Embeddings",
    role: emb,
    labels: {
      intro:
        "Embeddings power semantic recall over older conversations: the daily job turns each chat-day into topic summaries and embeds them, so the bot can find what was discussed weeks ago even when the wording differs. Without an embedding model the summaries are still written and keyword-searchable — only the semantic half is off.",
      backendHint: "The host serving /v1/embeddings.",
      modelLabel: "Embedding model",
      modelHint: `Must emit ${EMBEDDING_DIMENSIONS}-dimensional vectors (e.g. bge-m3) — the width this database stores. The test below embeds a phrase and shows the vector it produced.`,
      modelPlaceholder: "No embedding model (semantic recall off)",
      testLabel: "Test embeddings",
    },
    probe: {
      state: embedProbe.state,
      reset: embedProbe.reset,
      run: () => void embedProbe.run(roleProbeBody(emb)),
    },
  });

  const imagesBlock = roleBlock({
    id: "image",
    label: "Images",
    role: img,
    labels: {
      intro:
        "Image generation lets the bot draw a picture when someone asks it to, and send it to the chat. Each image it sends is then recognized like any received photo, so later replies know what it drew. Without an image model the tool is simply not offered — the bot says it cannot make images rather than pretending to.",
      backendHint: "The host serving /v1/images/generations.",
      modelLabel: "Image model",
      modelHint:
        "The model asked to draw. The test below actually generates a small picture and shows it — a diffusion model can take a while.",
      modelPlaceholder: "No image model (image generation off)",
      testLabel: "Test image generation",
    },
    probe: {
      state: imageProbe.state,
      reset: imageProbe.reset,
      run: () => void imageProbe.run(roleProbeBody(img)),
    },
  });

  const speechBlock = roleBlock({
    id: "speech",
    label: "Speech",
    role: spc,
    labels: {
      intro:
        "Speech lets the bot answer a voice message with a voice message: the reply text is synthesized on this endpoint and sent as a voice message. Without a speech model the bot still understands voice messages — it just always answers in text.",
      backendHint: "The host serving /v1/audio/speech.",
      modelLabel: "Speech model",
      modelHint:
        "The text-to-speech model voice replies use. The test below speaks a phrase in the voice below, so you can hear both before a chat does.",
      modelPlaceholder: "No speech model (voice replies off)",
      testLabel: "Test speech",
    },
    probe: {
      state: speechProbe.state,
      reset: speechProbe.reset,
      run: () => void speechProbe.run(roleProbeBody(spc)),
    },
    children: (
      <Field
        id="speechVoice"
        label="Voice"
        hint="Voice name the endpoint should speak with (e.g. alloy). Leave blank for the endpoint's default."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={speechVoice}
            onChange={(e) => setSpeechVoice(e.target.value)}
            placeholder="alloy"
          />
        )}
      </Field>
    ),
  });

  const audioBlock = roleBlock({
    id: "audio",
    label: "Audio",
    role: aud,
    fallsBackToChat: true,
    freeText: true,
    // In `transcriptions` mode the model is a whisper-class id the backend
    // usually does not list, so absence from a listing proves nothing. In
    // `chat` mode it is an ordinary chat model and must be listed.
    listed: audioTranscriptionMode === "chat",
    labels: {
      intro:
        "Audio turns incoming voice messages into text on a dedicated speech-to-text model. Whisper-class servers (whisper.cpp server, speaches, LocalAI…) take the audio on /v1/audio/transcriptions; providers like OpenRouter only take it through chat completions on an audio-capable model — pick the transcription mode to match. When no audio model is set, voice messages are transcribed by the chat model instead, which then must be audio-capable.",
      backendHint: "The host serving the speech-to-text model.",
      modelLabel: "Audio (STT) model",
      modelHint:
        "Free text — whisper-class servers often don't list models (e.g. whisper-1, Systran/faster-whisper-large-v3). Empty: voice falls back to the chat model.",
      modelPlaceholder: "No audio model (chat-model fallback)",
      testLabel: "Test audio",
    },
    probe: {
      state: audioProbe.state,
      reset: audioProbe.reset,
      run: () =>
        void audioProbe.run({ ...roleProbeBody(aud), transcriptionMode: audioTranscriptionMode }),
    },
    children: (
      <Field
        id="audioTranscriptionMode"
        label="Transcription mode"
        hint="How the endpoint takes audio: the dedicated /v1/audio/transcriptions route (whisper-class servers), or a chat completion carrying the audio (OpenRouter and other chat-only providers)."
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={audioTranscriptionMode}
            onChange={(e) => {
              setAudioTranscriptionMode(e.target.value as typeof audioTranscriptionMode);
              audioProbe.reset();
            }}
          >
            <option value="transcriptions">Transcriptions endpoint (/v1/audio/transcriptions)</option>
            <option value="chat">Chat completions (audio-capable chat model)</option>
          </Select>
        )}
      </Field>
    ),
  });

  const visionBlock = roleBlock({
    id: "vision",
    label: "Vision",
    role: vis,
    fallsBackToChat: true,
    labels: {
      intro:
        "Vision describes every photo, video, GIF and sticker the bot receives, so replies and history search know what is in them. By default the chat model does the describing (it must then be vision-capable); give this role its own backend or model to run the describer elsewhere.",
      backendHint: "The host serving the vision-capable chat completions.",
      modelLabel: "Vision model",
      modelHint: "The multimodal model that describes media. Empty: the chat model is used.",
      modelPlaceholder: "Use the chat model",
      testLabel: "Test vision",
    },
    probe: {
      state: visionProbe.state,
      reset: visionProbe.reset,
      run: () => void visionProbe.run(roleProbeBody(vis)),
    },
  });

  const browserBlock = roleBlock({
    id: "browser",
    label: "Browser agent",
    role: brw,
    fallsBackToChat: true,
    labels: {
      intro:
        "The browser agent drives a real browser to research pages and download files when a chat asks for it. By default it thinks on the chat backend and model; give it its own here — for example a larger-context model — without touching replies.",
      backendHint: "The host serving the browsing agent's chat completions.",
      modelLabel: "Browser agent model",
      modelHint:
        "The model that plans browser actions — it must support tool calls, which is what the test below checks. Empty: the chat model is used.",
      modelPlaceholder: "Use the chat model",
      testLabel: "Test browser model",
    },
    probe: {
      state: browserProbe.state,
      reset: browserProbe.reset,
      run: () => void browserProbe.run(roleProbeBody(brw)),
    },
  });

  const classifierBlock = roleBlock({
    id: "classifier",
    label: "Classifiers",
    role: cls,
    fallsBackToChat: true,
    labels: {
      intro:
        "Classifiers are the small yes/no questions each message costs before and after a reply: is this group message calling the bot, does the word it used really name it, does a standing rule apply, and does the drafted reply claim to have done something it did not. Each answers with a short JSON verdict — no tools, no history, no persona — and they run on every message, so they set how quickly the bot reacts at all. By default they run on the chat model; a small fast model here cuts that delay without touching reply quality.",
      backendHint: "The host serving the classifications.",
      modelLabel: "Classifier model",
      modelHint:
        "A small, fast model is the right choice — it only has to answer a fixed JSON question, which the test below checks by running the real addressing check. Empty: the chat model is used.",
      modelPlaceholder: "Use the chat model",
      testLabel: "Test classifier model",
    },
    probe: {
      state: classifierProbe.state,
      reset: classifierProbe.reset,
      run: () => void classifierProbe.run(roleProbeBody(cls)),
    },
  });

  const backgroundBlock = roleBlock({
    id: "background",
    label: "Background jobs",
    role: bgd,
    fallsBackToChat: true,
    labels: {
      intro:
        "Background jobs are the offline passes nobody waits for: the nightly history summaries, memory extraction and consolidation, analytics insights, and the bot's reflection on feedback. They read long transcripts and must answer in a structured shape that later replies read back, so this is the role for a capable or long-context model — it costs latency no one is waiting on. By default they run on the chat model.",
      backendHint: "The host serving the background jobs' chat completions.",
      modelLabel: "Background model",
      modelHint:
        "The model that summarizes and extracts. It must return the JSON these jobs store — the test below runs the real summarizer over a short transcript and shows the topics it produced. Empty: the chat model is used.",
      modelPlaceholder: "Use the chat model",
      testLabel: "Test background model",
    },
    probe: {
      state: backgroundProbe.state,
      reset: backgroundProbe.reset,
      run: () => void backgroundProbe.run(roleProbeBody(bgd)),
    },
  });

  const telegramTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Who operates the bots. Bot tokens are per assistant since the redesign — connect and
        manage them from each assistant&apos;s editor on the{" "}
        <Link href="/assistants" className="text-primary underline-offset-2 hover:underline">
          Assistants page
        </Link>
        .
      </p>

      <Field
        id="maintenanceMode"
        label="Maintenance mode"
        hint="When on, the bots stay fully functional for senders with owner rights (an assistant's owning account, and admins); everyone else gets a static maintenance notice."
      >
        {({ id, describedBy }) => (
          <div className="flex items-center gap-3">
            <Switch
              id={id}
              aria-describedby={describedBy}
              checked={maintenanceMode}
              onChange={(e) => setMaintenanceMode(e.target.checked)}
            />
            <span className="text-sm text-muted">{maintenanceMode ? "On" : "Off"}</span>
          </div>
        )}
      </Field>
    </div>
  );

  const generalTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Operational defaults that are not tied to any one backend or transport.
      </p>

      <Field
        id="timezone"
        label="Timezone"
        hint="IANA timezone for scheduled tasks — a task at '09:00 daily' fires at 09:00 here. e.g. Europe/Berlin."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="UTC"
          />
        )}
      </Field>

      <Field
        id="dailyJobsRunTime"
        label="Daily jobs run time"
        hint="Local time (HH:MM, in the timezone above) the nightly jobs run: distilling user feedback into preferences, and compressing each finished chat-day into searchable topic summaries."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={dailyJobsRunTime}
            onChange={(e) => setDailyJobsRunTime(e.target.value)}
            placeholder="04:00"
          />
        )}
      </Field>

      <Field
        id="assistantLoopGuardTurns"
        label="Assistant replies in a row"
        hint="How many assistant messages a chat may hold in a row before every assistant there goes quiet until a person speaks again. Assistants cannot see each other on Telegram, so the bot hands each reply to the others sharing a chat — this bounds how long they keep talking to each other. 0 stops them from answering each other at all. 0–10."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="number"
            min={0}
            max={10}
            aria-describedby={describedBy}
            value={loopGuardTurns}
            onChange={(e) => setLoopGuardTurns(e.target.value)}
            placeholder="3"
          />
        )}
      </Field>

      <Field
        id="browserDownloadLimitGb"
        label="Browser download size limit (GB)"
        hint="Hard ceiling on a single download, whichever tool the agent uses — a file, a muxed stream, or a media extraction. A disk guard only: it never makes the agent pick a lower quality. 1–100."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={100}
            aria-describedby={describedBy}
            value={browserDownloadLimitGb}
            onChange={(e) => setBrowserDownloadLimitGb(e.target.value)}
            placeholder="10"
          />
        )}
      </Field>
    </div>
  );

  const integrationsTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Optional integrations that unlock extra tools. The bot runs without these.
      </p>

      <Field
        id="tavilyApiKey"
        label="Tavily API key"
        hint="Fallback search API for the browsing agent, used only when no search engine will load in the browser. Stored securely; never shown again."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={tavilyKey.value}
            onChange={(e) => tavilyKey.set(e.target.value)}
            placeholder={tavilyKey.placeholderFor("tvly-…")}
          />
        )}
      </Field>
    </div>
  );

  // Chat first — every other role's default answer is "whatever chat uses", so
  // it is the one that has to be decided before the rest mean anything.
  const roleBlocks: RoleBlock[] = [
    chatBlock,
    embeddingsBlock,
    imagesBlock,
    speechBlock,
    audioBlock,
    visionBlock,
    browserBlock,
    classifierBlock,
    backgroundBlock,
  ];

  // Roles whose saved model the effective backend provably does not serve. On
  // nine separate tabs this was only visible to someone who happened to open
  // the right one; here it is the first thing the tab says.
  const staleRoles = roleBlocks.filter((block) => block.stale);

  const modelsTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Every LLM role in one place. Chat is the main model; the roles below it use the chat
        backend unless given their own, and most fall back to the chat model too — so changing
        Chat changes them, and anything the new backend does not serve is flagged here and
        cleared on save.
      </p>

      {noBackendsNote}

      {staleRoles.length > 0 ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          {staleRoles.map((block) => block.spec.label).join(", ")}{" "}
          {staleRoles.length === 1 ? "has a model" : "have models"} the configured backend does
          not serve. Pick replacements below, or save to clear{" "}
          {staleRoles.length === 1 ? "it" : "them"}.
        </p>
      ) : null}

      {/* What the last save cleared. This lives here rather than beside the Save
          button: it names roles, and the roles are on this tab — the floating
          button carries the verdict ("Saved"), not the consequences. */}
      {save.kind === "saved" && clearedOnSave.length > 0 ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Cleared {clearedOnSave.join(", ")} — not served by the configured backend. Pick
          replacements in their sections when ready.
        </p>
      ) : null}

      <nav aria-label="Roles" className="flex flex-wrap gap-1.5">
        {roleBlocks.map((block) => (
          <a
            key={block.spec.id}
            href={`#role-${block.spec.id}`}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
              block.stale
                ? "border-warning/40 bg-warning/10 text-warning"
                : "border-border bg-surface-2 text-muted hover:text-foreground",
            )}
          >
            {block.spec.label}
          </a>
        ))}
      </nav>

      {/* One card per role. Dividers made nine settings read as one long form;
          a card gives each role its own edge, so it is obvious where the thing
          you are editing starts and stops. `muted` because the whole form
          already sits inside a Card — a nested plain one would be invisible. */}
      <div className="space-y-4">
        {roleBlocks.map((block) => {
          const summary = roleSummary(block);
          return (
            <Card
              key={block.spec.id}
              muted
              id={`role-${block.spec.id}`}
              className={cn("scroll-mt-6", block.stale && "border-warning/40")}
            >
              <CardHeader>
                <CardTitle className="text-base">{block.spec.label}</CardTitle>
                <CardAction>
                  <Badge tone={summary.tone}>{summary.text}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>{block.content}</CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );

  const tabs: TabItem[] = [
    { id: "models", label: "Models", content: modelsTab },
    { id: "bots", label: "Bots", content: telegramTab },
    { id: "general", label: "General", content: generalTab },
    { id: "integrations", label: "Integrations", content: integrationsTab },
    { id: "security", label: "Security", content: <ChangePasswordSection /> },
  ];

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <Tabs tabs={tabs} value={activeTab} onValueChange={setActiveTab} />

      {/* The Security tab keeps its own button: changing a password is a
          different write, on a different endpoint, and a floating "Save
          settings" beside it would be an invitation to press the wrong one. */}
      {activeTab !== "security" ? (
        <Fab
          label="Save settings"
          busyLabel="Saving…"
          icon={<Save className="h-4 w-4" />}
          onClick={onSave}
          busy={save.kind === "saving"}
          status={
            save.kind === "saved"
              ? { tone: "success", text: "Saved" }
              : save.kind === "error"
                ? { tone: "danger", text: save.message }
                : null
          }
        />
      ) : null}
    </form>
  );
}

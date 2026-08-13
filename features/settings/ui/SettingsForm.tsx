"use client";

import { Check, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Button, Field, Input, Select, Switch, Tabs, type TabItem } from "@/components/ui";
import type { Backend } from "@/features/backends/server/schema";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { KnownUser } from "@/features/known-users/server/schema";
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
 * Bot settings editor. Client Component with one tab per concern. The LLM
 * configuration is per **role** — Chat (the main model every reply runs on,
 * which must support thinking and tool calls), Embeddings, Images, Speech,
 * Audio (STT), Vision, Browser agent, Classifiers (the per-message checks) and
 * Background jobs (the nightly passes) — and every role picks a backend from
 * the shared catalog (managed on the Backends page) plus a model through a
 * searchable select fed by that backend's live model list. A role without its
 * own backend uses the chat backend; audio/vision/browser/classifier/background
 * additionally fall back to the chat model when none is picked ("main by
 * default").
 *
 * One Save button below the tabs persists every changed field regardless of
 * the active tab. Secrets are write-only — shown as "configured" but their
 * values never leave the server.
 *
 * Only changed fields are sent, which the server relies on: a model absent
 * from the patch is a *stored* selection, and when the same patch repoints the
 * backend serving it, the server verifies it against the new backend's model
 * list and clears it if it is not served. The form covers the case that check
 * cannot see — a selection stale against the *unchanged* backend: a
 * successfully listed backend that does not serve the stored model flags it on
 * its tab, and the save sends it as null. Either way, everything cleared is
 * named next to the Save button.
 */

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One LLM role tab, as data. Every axis here is a real difference between the
 * roles; anything not listed is shared behaviour and is decided once in
 * {@link SettingsForm.roleTab}, so the tabs cannot drift apart.
 */
interface RoleTabSpec {
  /** Tab id, also the field-id prefix ("embedding" → `embeddingModel`). */
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

export function SettingsForm({
  initial,
  backends = [],
  initialBackendModels = {},
  knownUsers = [],
}: {
  initial: Settings;
  /** The saved backend catalog the role selects offer. */
  backends?: Backend[];
  /** Models preloaded server-side per backend id, so dropdowns work on open. */
  initialBackendModels?: Record<string, string[]>;
  /** Users who have messaged the bot — the owner is chosen from this list. */
  knownUsers?: KnownUser[];
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
  const botToken = useSecretField(initial.telegramBotTokenConfigured);
  const tavilyKey = useSecretField(initial.webSearchConfigured);
  const [ownerUserId, setOwnerUserId] = useState(initial.ownerUserId ?? "");
  const [maintenanceMode, setMaintenanceMode] = useState(initial.maintenanceModeEnabled);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyJobsRunTime, setDailyJobsRunTime] = useState(initial.dailyJobsRunTime);
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
  const [activeTab, setActiveTab] = useState("chat");

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
    if (botToken.dirty) patch.telegramBotToken = botToken.patchValue;
    if (tavilyKey.dirty) patch.tavilyApiKey = tavilyKey.patchValue;
    if (speechVoice.trim() !== (initial.speechVoice ?? "")) {
      patch.speechVoice = speechVoice.trim() === "" ? null : speechVoice.trim();
    }
    if (ownerUserId !== (initial.ownerUserId ?? "")) {
      patch.ownerUserId = ownerUserId === "" ? null : ownerUserId;
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
      botToken.clear();
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
      setOwnerUserId(data.ownerUserId ?? "");
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setDailyJobsRunTime(data.dailyJobsRunTime);
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
   * Render one LLM role tab. Everything the roles must agree on is decided
   * here, once: changing a backend (or a model, when the probe tests one)
   * clears that role's stale probe result, the model list drives the stale
   * warning, and a role whose empty model means "use the chat model" stays
   * testable without one. Per-role differences arrive as {@link RoleTabSpec}.
   */
  function roleTab(spec: RoleTabSpec): TabItem {
    const { role, probe } = spec;
    const listed = spec.listed ?? true;
    return {
      id: spec.id,
      label: spec.label,
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

  const chatTabItem = roleTab({
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

  // The Chat tab alone carries the "no backends yet" note: it is where the
  // catalog is first needed, and repeating it on all seven would be noise.
  const chatTabWithNote: TabItem = {
    ...chatTabItem,
    content: (
      <div className="space-y-5">
        {noBackendsNote}
        {chatTabItem.content}
      </div>
    ),
  };

  const embeddingsTabItem = roleTab({
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

  const imagesTabItem = roleTab({
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

  const speechTabItem = roleTab({
    id: "speech",
    label: "Speech",
    role: spc,
    labels: {
      intro:
        "Speech lets the bot answer a voice message with a voice message: the reply text is synthesized on this endpoint and sent as a Telegram voice bubble. Without a speech model the bot still understands voice messages — it just always answers in text.",
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

  const audioTabItem = roleTab({
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

  const visionTabItem = roleTab({
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

  const browserTabItem = roleTab({
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

  const classifierTabItem = roleTab({
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

  const backgroundTabItem = roleTab({
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
        How the bot connects to Telegram and who operates it. Save the token, then start the bot
        from the Overview.
      </p>

      <Field
        id="telegramBotToken"
        label="Telegram bot token"
        hint="From @BotFather. Stored securely; never shown again. Save, then start the bot from the Overview."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={botToken.value}
            onChange={(e) => botToken.set(e.target.value)}
            placeholder={botToken.placeholderFor("123456:ABC-DEF…")}
          />
        )}
      </Field>

      <Field
        id="ownerUserId"
        label="Owner"
        hint={
          knownUsers.length > 0
            ? "The bot owner controls maintenance mode. Chosen from users who have messaged the bot."
            : "No users yet — the owner is chosen from people who have messaged the bot. Start the bot and message it first."
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={ownerUserId}
            disabled={knownUsers.length === 0}
            onChange={(e) => setOwnerUserId(e.target.value)}
          >
            <option value="">No owner</option>
            {knownUsers.map((u) => (
              <option key={u.userId} value={u.userId}>
                {formatKnownUserLabel(u)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field
        id="maintenanceMode"
        label="Maintenance mode"
        hint="When on, the bot stays fully functional for the owner only; everyone else gets a static maintenance notice."
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
        Operational defaults that are not tied to any one backend or to Telegram.
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

  const tabs: TabItem[] = [
    chatTabWithNote,
    embeddingsTabItem,
    imagesTabItem,
    speechTabItem,
    audioTabItem,
    visionTabItem,
    browserTabItem,
    classifierTabItem,
    backgroundTabItem,
    { id: "telegram", label: "Telegram", content: telegramTab },
    { id: "general", label: "General", content: generalTab },
    { id: "integrations", label: "Integrations", content: integrationsTab },
    { id: "security", label: "Security", content: <ChangePasswordSection /> },
  ];

  return (
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      <Tabs tabs={tabs} value={activeTab} onValueChange={setActiveTab} />

      {activeTab !== "security" ? (
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <Button
            type="button"
            onClick={onSave}
            disabled={save.kind === "saving"}
            leftIcon={<Save className="h-4 w-4" />}
          >
            {save.kind === "saving" ? "Saving…" : "Save settings"}
          </Button>
          {save.kind === "saved" ? (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" aria-hidden /> Saved
            </span>
          ) : null}
          {save.kind === "saved" && clearedOnSave.length > 0 ? (
            <span className="text-sm text-warning">
              Cleared {clearedOnSave.join(", ")} — not served by the configured backend. Pick
              replacements on their tabs when ready.
            </span>
          ) : null}
          {save.kind === "error" ? (
            <span className="text-sm text-danger">{save.message}</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

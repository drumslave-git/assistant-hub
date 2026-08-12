"use client";

import { Check, Plug, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, Button, Field, Input, Select, Switch, Tabs, type TabItem } from "@/components/ui";
import { formatKnownUserLabel } from "@/features/known-users/format";
import type { KnownUser } from "@/features/known-users/server/schema";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import type { LlmBackendId } from "@/lib/llm-backend";
import type { Settings } from "../server/schema";
import {
  readError,
  useBackendConnection,
  useProbe,
  useSecretField,
  useSectionModels,
  type BackendConnection,
  type SectionModelsState,
} from "./connection";
import { BackendField } from "./BackendField";
import { ChangePasswordSection } from "./ChangePasswordSection";
import { ConnectionSection } from "./ConnectionSection";

/**
 * Bot settings editor. Client Component with nine tabs, one per concern: **LLM**
 * (the chat endpoint, key, backend and model), **Embeddings** (the endpoint
 * powering semantic recall over history summaries), **Images** (image
 * generation), **Speech** (voice replies), **Transcription** (speech-to-text for
 * voice messages, chat-model fallback), **Telegram** (bot token, owner,
 * maintenance mode), **General** (timezone, daily jobs, download limit),
 * **Integrations** (optional feature keys like Tavily for web search), and
 * **Security** (operator password change — its own endpoint and button, not part
 * of the settings patch). One Save button below the tabs persists every changed
 * field regardless of the active tab. Secret keys are write-only — shown as
 * "configured" but their values never leave the server.
 *
 * Only changed fields are sent, which the server relies on: a model absent from
 * the patch is a *stored* selection, and when the same patch repoints the
 * endpoint serving it, the server verifies it against the new endpoint's model
 * list and clears it if it is not served (see `clearStaleModelSelections`).
 * The form covers the case that check cannot see — a selection stale against
 * the *unchanged* endpoint (e.g. left behind by a switch made before this
 * existed): a fresh "Test connection" flags it on its own tab, and the save
 * sends it as null. Either way, everything cleared is named next to the Save
 * button.
 *
 * The repeated machinery lives in `connection.ts` (probe + secret-input + backend
 * state hooks) and `ConnectionSection.tsx` (the embeddings/images section shell);
 * this component is composition plus the save patch.
 */

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function SettingsForm({
  initial,
  initialModels = [],
  initialEmbeddingModels = [],
  initialImageModels = [],
  initialSpeechModels = [],
  initialTranscriptionModels = [],
  knownUsers = [],
}: {
  initial: Settings;
  /** Models preloaded server-side for the saved endpoint, so the dropdown is
   *  populated on open without a manual "Test connection". */
  initialModels?: string[];
  /** Models preloaded from the embedding endpoint (or the LLM one, when it serves both). */
  initialEmbeddingModels?: string[];
  /** Models preloaded from the image endpoint (or the LLM one, when it serves both). */
  initialImageModels?: string[];
  /** Models preloaded from the speech endpoint (or the LLM one, when it serves both). */
  initialSpeechModels?: string[];
  /** Models preloaded from the transcription endpoint (often empty — whisper servers rarely list). */
  initialTranscriptionModels?: string[];
  /** Users who have messaged the bot — the owner is chosen from this list. */
  knownUsers?: KnownUser[];
}) {
  const router = useRouter();

  // Core LLM connection.
  const [llmBaseUrl, setLlmBaseUrl] = useState(initial.llmBaseUrl ?? "");
  const [llmBackend, setLlmBackend] = useState<LlmBackendId>(initial.llmBackend);
  const apiKey = useSecretField(initial.apiKeyConfigured);
  const [model, setModel] = useState(initial.model ?? "");
  // Seed with the server-preloaded list (falling back to just the saved model);
  // a successful "Test connection" replaces this with a fresh list.
  const [models, setModels] = useState<string[]>(
    initialModels.length > 0 ? initialModels : initial.model ? [initial.model] : [],
  );
  const connProbe = useProbe<{ models: string[] }>("/api/settings/test-connection");

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

  // Optional backends. Editing a section invalidates its own probe result.
  const embedProbe = useProbe<{ model: string; dimensions: number }>(
    "/api/settings/test-embeddings",
  );
  const emb = useBackendConnection(
    { baseUrl: initial.embeddingBaseUrl, model: initial.embeddingModel, backend: initial.embeddingBackend },
    embedProbe.reset,
  );
  const embKey = useSecretField(initial.embeddingApiKeyConfigured);
  const imageProbe = useProbe<{ model: string; modelCount: number }>("/api/settings/test-images");
  const img = useBackendConnection(
    { baseUrl: initial.imageBaseUrl, model: initial.imageModel, backend: initial.imageBackend },
    imageProbe.reset,
  );
  const imgKey = useSecretField(initial.imageApiKeyConfigured);
  const speechProbe = useProbe<{ model: string; modelCount: number }>("/api/settings/test-speech");
  const spc = useBackendConnection(
    { baseUrl: initial.speechBaseUrl, model: initial.speechModel, backend: initial.speechBackend },
    speechProbe.reset,
  );
  const spcKey = useSecretField(initial.speechApiKeyConfigured);
  const [speechVoice, setSpeechVoice] = useState(initial.speechVoice ?? "");
  const transcriptionProbe = useProbe<{ model: string; text: string }>(
    "/api/settings/test-transcription",
  );
  const stt = useBackendConnection(
    { baseUrl: initial.transcriptionBaseUrl, model: initial.transcriptionModel, backend: initial.transcriptionBackend },
    transcriptionProbe.reset,
  );
  const sttKey = useSecretField(initial.transcriptionApiKeyConfigured);

  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // Model selections the server cleared on the last save because the repointed
  // endpoint verifiably does not serve them — shown next to the Save button,
  // since the sections they belong to live on other tabs.
  const [clearedOnSave, setClearedOnSave] = useState<string[]>([]);
  // Controlled so the global Save row can step aside on the Security tab, whose
  // password change has its own endpoint and button — two visible submit
  // buttons for one visible form invite pressing the wrong one.
  const [activeTab, setActiveTab] = useState("llm");

  // Probe the LLM endpoint (a user action, not an effect); its model list also
  // feeds the dropdowns below.
  async function onTest(event: React.FormEvent) {
    event.preventDefault();
    if (llmBaseUrl.trim() === "") return;
    const data = await connProbe.run({
      llmBaseUrl,
      // Only send the key when the operator typed one; otherwise the server
      // tests with the stored key and the secret never round-trips.
      ...(apiKey.dirty ? { apiKey: apiKey.value } : {}),
    });
    if (data) setModels(data.models);
  }

  // Probe the embedding endpoint with a real embed call: it reports the vector
  // width, which is the one thing a model listing cannot tell us and the one
  // mismatch that would break every later write.
  function onTestEmbeddings() {
    if (emb.model.trim() === "" || emb.urlMissing) return;
    void embedProbe.run({
      embeddingBaseUrl: emb.resolvedUrl,
      embeddingModel: emb.model,
      ...(embKey.dirty ? { embeddingApiKey: embKey.value.trim() } : {}),
    });
  }

  // Probe the image endpoint. Unlike embeddings this does not make a real
  // generation — nothing about an image can only be learned by drawing it, and a
  // diffusion model would keep the operator waiting minutes for the answer.
  function onTestImages() {
    if (img.model.trim() === "" || img.urlMissing) return;
    void imageProbe.run({
      imageBaseUrl: img.resolvedUrl,
      imageModel: img.model,
      ...(imgKey.dirty ? { imageApiKey: imgKey.value.trim() } : {}),
    });
  }

  // Probe the speech endpoint. Like images, this checks the model is served
  // rather than synthesizing audio — the listing already proves the connection.
  function onTestSpeech() {
    if (spc.model.trim() === "" || spc.urlMissing) return;
    void speechProbe.run({
      speechBaseUrl: spc.resolvedUrl,
      speechModel: spc.model,
      ...(spcKey.dirty ? { speechApiKey: spcKey.value.trim() } : {}),
    });
  }

  // Probe the transcription endpoint with a real call (it transcribes a
  // fraction of a second of silence): whisper-class servers often have no
  // model listing, so only a genuine transcription proves the connection.
  function onTestTranscription() {
    if (stt.model.trim() === "" || stt.urlMissing) return;
    void transcriptionProbe.run({
      transcriptionBaseUrl: stt.resolvedUrl,
      transcriptionModel: stt.model,
      ...(sttKey.dirty ? { transcriptionApiKey: sttKey.value.trim() } : {}),
    });
  }

  async function onSave() {
    setSave({ kind: "saving" });
    setClearedOnSave([]);
    // Changed fields only. The server depends on that: a model missing from the
    // patch is a stored selection, which it verifies (and clears) when the same
    // patch repoints the endpoint serving it.
    const trimmedLlmUrl = llmBaseUrl.trim() === "" ? null : llmBaseUrl.trim();
    const pickedModel = model === "" ? null : model;
    const patch: Record<string, unknown> = {
      ...(trimmedLlmUrl !== (initial.llmBaseUrl ?? null) ? { llmBaseUrl: trimmedLlmUrl } : {}),
      ...(llmBackend !== initial.llmBackend ? { llmBackend } : {}),
      ...(pickedModel !== (initial.model ?? null) ? { model: pickedModel } : {}),
      // Sent only for a section that has its own host. One reusing the LLM
      // connection inherits that endpoint's backend at read time, so persisting
      // a value for it would be a second, silently-ignored source of truth.
      ...(emb.separate && emb.backend !== initial.embeddingBackend
        ? { embeddingBackend: emb.backend }
        : {}),
      ...(img.separate && img.backend !== initial.imageBackend
        ? { imageBackend: img.backend }
        : {}),
      ...(spc.separate && spc.backend !== initial.speechBackend
        ? { speechBackend: spc.backend }
        : {}),
      ...(stt.separate && stt.backend !== initial.transcriptionBackend
        ? { transcriptionBackend: stt.backend }
        : {}),
    };
    if (apiKey.dirty) patch.apiKey = apiKey.patchValue;
    if (botToken.dirty) patch.telegramBotToken = botToken.patchValue;
    if (tavilyKey.dirty) patch.tavilyApiKey = tavilyKey.patchValue;
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
    if (emb.resolvedUrl !== (initial.embeddingBaseUrl ?? null)) {
      patch.embeddingBaseUrl = emb.resolvedUrl;
    }
    if (emb.model !== (initial.embeddingModel ?? "")) {
      patch.embeddingModel = emb.model === "" ? null : emb.model;
    }
    // Turning the separate backend off clears its key too: it authenticated a host
    // we are no longer calling, and leaving it behind would resurrect on re-enable.
    if (!emb.separate && initial.embeddingApiKeyConfigured) {
      patch.embeddingApiKey = null;
    } else if (embKey.dirty) {
      patch.embeddingApiKey = embKey.patchValue;
    }
    if (img.resolvedUrl !== (initial.imageBaseUrl ?? null)) {
      patch.imageBaseUrl = img.resolvedUrl;
    }
    if (img.model !== (initial.imageModel ?? "")) {
      patch.imageModel = img.model === "" ? null : img.model;
    }
    // Same rule as the embedding key above: dropping the separate backend drops
    // the key that authenticated it.
    if (!img.separate && initial.imageApiKeyConfigured) {
      patch.imageApiKey = null;
    } else if (imgKey.dirty) {
      patch.imageApiKey = imgKey.patchValue;
    }
    if (spc.resolvedUrl !== (initial.speechBaseUrl ?? null)) {
      patch.speechBaseUrl = spc.resolvedUrl;
    }
    if (spc.model !== (initial.speechModel ?? "")) {
      patch.speechModel = spc.model === "" ? null : spc.model;
    }
    if (!spc.separate && initial.speechApiKeyConfigured) {
      patch.speechApiKey = null;
    } else if (spcKey.dirty) {
      patch.speechApiKey = spcKey.patchValue;
    }
    if (speechVoice.trim() !== (initial.speechVoice ?? "")) {
      patch.speechVoice = speechVoice.trim() === "" ? null : speechVoice.trim();
    }
    if (stt.resolvedUrl !== (initial.transcriptionBaseUrl ?? null)) {
      patch.transcriptionBaseUrl = stt.resolvedUrl;
    }
    if (stt.model.trim() !== (initial.transcriptionModel ?? "")) {
      patch.transcriptionModel = stt.model.trim() === "" ? null : stt.model.trim();
    }
    if (!stt.separate && initial.transcriptionApiKeyConfigured) {
      patch.transcriptionApiKey = null;
    } else if (sttKey.dirty) {
      patch.transcriptionApiKey = sttKey.patchValue;
    }

    // A selection a fresh "Test connection" proved stale is cleared with the
    // save, exactly as the warning on its tab promises. This is the client's
    // half of the job: the server only verifies when the same patch moves an
    // endpoint, which a leftover stale against the *unchanged* endpoint never
    // triggers. The probe resets on any URL edit, so a fresh list always
    // describes the endpoint currently in the form.
    const staleCleared: string[] = [];
    if (connProbe.state.kind === "ok") {
      if (model !== "" && !models.includes(model)) {
        patch.model = null;
        staleCleared.push("chat model");
      }
      if (!emb.separate && emb.model !== "" && !models.includes(emb.model)) {
        patch.embeddingModel = null;
        staleCleared.push("embedding model");
      }
      if (!img.separate && img.model !== "" && !models.includes(img.model)) {
        patch.imageModel = null;
        staleCleared.push("image model");
      }
      if (!spc.separate && spc.model !== "" && !models.includes(spc.model)) {
        patch.speechModel = null;
        staleCleared.push("speech model");
      }
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
      // Everything cleared for staleness gets named next to the Save button —
      // its own tab may not be the visible one. Two sources: what this client
      // cleared from its own fresh probe, and a stored selection we did not
      // send that came back null, which the server cleared after verifying it
      // against the endpoint this same patch repointed.
      const cleared: string[] = [...staleCleared];
      if (!("model" in patch) && model !== "" && data.model === null) cleared.push("chat model");
      if (!("embeddingModel" in patch) && emb.model !== "" && data.embeddingModel === null) {
        cleared.push("embedding model");
      }
      if (!("imageModel" in patch) && img.model !== "" && data.imageModel === null) {
        cleared.push("image model");
      }
      if (!("speechModel" in patch) && spc.model !== "" && data.speechModel === null) {
        cleared.push("speech model");
      }
      setClearedOnSave(cleared);
      apiKey.clear();
      botToken.clear();
      tavilyKey.clear();
      embKey.clear();
      imgKey.clear();
      spcKey.clear();
      sttKey.clear();
      setModel(data.model ?? "");
      setOwnerUserId(data.ownerUserId ?? "");
      setMaintenanceMode(data.maintenanceModeEnabled);
      setTimezone(data.timezone);
      setDailyJobsRunTime(data.dailyJobsRunTime);
      setBrowserDownloadLimitGb(String(data.browserDownloadLimitGb));
      setLlmBackend(data.llmBackend);
      emb.applySaved({
        baseUrl: data.embeddingBaseUrl,
        model: data.embeddingModel,
        backend: data.embeddingBackend,
      });
      img.applySaved({
        baseUrl: data.imageBaseUrl,
        model: data.imageModel,
        backend: data.imageBackend,
      });
      spc.applySaved({
        baseUrl: data.speechBaseUrl,
        model: data.speechModel,
        backend: data.speechBackend,
      });
      setSpeechVoice(data.speechVoice ?? "");
      stt.applySaved({
        baseUrl: data.transcriptionBaseUrl,
        model: data.transcriptionModel,
        backend: data.transcriptionBackend,
      });
      setSave({ kind: "saved" });
      // Re-read server state so masked "configured" placeholders reflect the save.
      router.refresh();
    } catch {
      setSave({ kind: "error", message: "Network error — could not reach the server" });
    }
  }

  const canPickModel = models.length > 0;

  // A successful "Test connection" makes the LLM endpoint's list authoritative
  // for every section reusing that connection: a selection absent from it is
  // provably stale (the exact state a backend switch leaves behind).
  const llmListFresh = connProbe.state.kind === "ok";
  const staleWarning = (m: string) =>
    `"${m}" is not served by the tested endpoint — it will be cleared on save unless you pick another.`;

  // Live model lists for sections pointed at an endpoint that differs from the
  // saved one — the server preload cannot describe a URL the operator just
  // typed, which used to leave the dropdown offering the old host's models
  // until a blind save.
  const embFetched = useSectionModels("embedding", emb, embKey);
  const imgFetched = useSectionModels("image", img, imgKey);
  const spcFetched = useSectionModels("speech", spc, spcKey);
  const sttFetched = useSectionModels("transcription", stt, sttKey);

  /** The fetched list, only when it describes the URL currently in the form. */
  const fetchedModels = (conn: BackendConnection, fetched: SectionModelsState) =>
    conn.separate && fetched.kind === "ok" && fetched.url === conn.resolvedUrl
      ? fetched.models
      : null;

  // Options for one section's model select. When the section shares the LLM
  // endpoint (the common case — no separate URL), the endpoint's own model list
  // is authoritative, so a "Test connection" on the LLM tab refreshes the
  // dropdown too. With a separate host, a live fetch from the URL currently in
  // the form wins; the server preload (the saved host's list) is the fallback.
  // The saved model is kept as an option — so an unreachable endpoint cannot
  // silently blank out a working selection — unless it is provably stale, in
  // which case keeping it would re-offer exactly the selection the save is
  // about to clear.
  function sectionModels(
    conn: BackendConnection,
    preloaded: string[],
    fetched: SectionModelsState,
  ) {
    const fresh = fetchedModels(conn, fetched);
    const listed = !conn.separate && models.length > 0 ? models : (fresh ?? preloaded);
    const listFresh = conn.separate ? fresh !== null : llmListFresh;
    const stale = listFresh && conn.model !== "" && !listed.includes(conn.model);
    const options =
      conn.model && !listed.includes(conn.model) && !stale ? [conn.model, ...listed] : listed;
    const fetchError =
      conn.separate && fetched.kind === "error" && fetched.url === conn.resolvedUrl
        ? `Could not list models from this endpoint: ${fetched.message}`
        : null;
    return { options, warning: stale ? staleWarning(conn.model) : fetchError };
  }

  const embeddingModels = sectionModels(emb, initialEmbeddingModels, embFetched);
  const imageModels = sectionModels(img, initialImageModels, imgFetched);
  const speechModels = sectionModels(spc, initialSpeechModels, spcFetched);

  // Transcription model suggestions (free-text field — whisper servers rarely list).
  const transcriptionModels =
    !stt.separate && models.length > 0
      ? models
      : (fetchedModels(stt, sttFetched) ?? initialTranscriptionModels);

  const chatModelStale = llmListFresh && model !== "" && !models.includes(model);

  const llmTab = (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        The chat endpoint and model every reply runs on. The optional endpoints on the other tabs
        reuse this connection unless given their own — so repointing it here repoints them too, and
        any of their model selections the new endpoint does not serve is cleared on save.
      </p>

      <Field
        id="llmBaseUrl"
        label="OpenAI-compatible API URL"
        hint="e.g. https://api.openai.com/v1 or http://localhost:11434/v1"
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="url"
            inputMode="url"
            value={llmBaseUrl}
            onChange={(e) => {
              setLlmBaseUrl(e.target.value);
              connProbe.reset();
            }}
            placeholder="https://api.openai.com/v1"
          />
        )}
      </Field>

      <Field
        id="apiKey"
        label="API key"
        hint="Optional — required by hosted providers, not by local ones. Stored securely; never shown again."
      >
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            type="password"
            autoComplete="off"
            value={apiKey.value}
            onChange={(e) => apiKey.set(e.target.value)}
            placeholder={apiKey.placeholderFor("optional")}
          />
        )}
      </Field>

      <BackendField
        idPrefix="llm"
        value={llmBackend}
        onChange={setLlmBackend}
        baseUrl={llmBaseUrl.trim() === "" ? null : llmBaseUrl.trim()}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="outline"
          disabled={connProbe.state.kind === "testing" || llmBaseUrl.trim() === ""}
          leftIcon={<Plug className="h-4 w-4" />}
        >
          {connProbe.state.kind === "testing" ? "Testing…" : "Test connection"}
        </Button>
        {connProbe.state.kind === "ok" ? (
          <Badge tone="success" dot>
            Connected — {connProbe.state.result.models.length} models
          </Badge>
        ) : null}
        {connProbe.state.kind === "error" ? (
          <span className="text-sm text-danger">{connProbe.state.message}</span>
        ) : null}
      </div>

      <Field
        id="model"
        label="Model"
        hint={
          canPickModel
            ? "Select the chat model used for replies."
            : "Test the connection to load available models."
        }
      >
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={model}
            disabled={!canPickModel}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Select a model…</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {chatModelStale ? <p className="text-sm text-warning">{staleWarning(model)}</p> : null}
    </div>
  );

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
        Operational defaults that are not tied to any one endpoint or to Telegram.
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

  const embeddingsTab = (
    <ConnectionSection
      idPrefix="embedding"
      labels={{
        intro:
          "Embeddings power semantic recall over older conversations: the daily job turns each chat-day into topic summaries and embeds them, so the bot can find what was discussed weeks ago even when the wording differs. Without an embedding model the summaries are still written and keyword-searchable — only the semantic half is off.",
        switchLabel: "Separate embedding backend",
        switchHint:
          "Off: embeddings are requested from the same backend as the LLM. On: they are served by a different host, which you give below.",
        urlLabel: "Embedding API URL",
        urlHint: "Required — the host serving /v1/embeddings.",
        urlPlaceholder: "https://embeddings.example.com/v1",
        urlMissingError: "An embedding API URL is required.",
        keyLabel: "Embedding API key",
        modelLabel: "Embedding model",
        modelHint: `Must emit ${EMBEDDING_DIMENSIONS}-dimensional vectors (e.g. bge-m3) — the width this database stores. Test below to confirm.`,
        modelEmptyOption: "No embedding model (semantic recall off)",
        testLabel: "Test embeddings",
        testingLabel: "Testing…",
      }}
      conn={emb}
      secret={embKey}
      models={embeddingModels.options}
      modelWarning={embeddingModels.warning}
      probe={embedProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — {r.dimensions} dimensions
        </>
      )}
      onTest={onTestEmbeddings}
    />
  );

  const imagesTab = (
    <ConnectionSection
      idPrefix="image"
      labels={{
        intro:
          "Image generation lets the bot draw a picture when someone asks it to, and send it to the chat. Each image it sends is then recognized like any received photo, so later replies know what it drew. Without an image model the tool is simply not offered — the bot says it cannot make images rather than pretending to.",
        switchLabel: "Separate image backend",
        switchHint:
          "Off: images are requested from the same backend as the LLM. On: they are served by a different host, which you give below.",
        urlLabel: "Image API URL",
        urlHint: "Required — the host serving /v1/images/generations.",
        urlPlaceholder: "https://images.example.com/v1",
        urlMissingError: "An image API URL is required.",
        keyLabel: "Image API key",
        modelLabel: "Image model",
        modelHint: "The model asked to draw. Test below to confirm the endpoint actually serves it.",
        modelEmptyOption: "No image model (image generation off)",
        testLabel: "Test image endpoint",
        testingLabel: "Testing…",
      }}
      conn={img}
      secret={imgKey}
      models={imageModels.options}
      modelWarning={imageModels.warning}
      probe={imageProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — served ({r.modelCount} models)
        </>
      )}
      onTest={onTestImages}
    />
  );

  const speechTab = (
    <ConnectionSection
      idPrefix="speech"
      labels={{
        intro:
          "Speech lets the bot answer a voice message with a voice message: the reply text is synthesized on this endpoint and sent as a Telegram voice bubble. Without a speech model the bot still understands voice messages (they are transcribed by the chat model) — it just always answers in text.",
        switchLabel: "Separate speech backend",
        switchHint:
          "Off: speech is requested from the same backend as the LLM. On: it is served by a different host, which you give below.",
        urlLabel: "Speech API URL",
        urlHint: "Required — the host serving /v1/audio/speech.",
        urlPlaceholder: "https://speech.example.com/v1",
        urlMissingError: "A speech API URL is required.",
        keyLabel: "Speech API key",
        modelLabel: "Speech model",
        modelHint:
          "The text-to-speech model voice replies use. Test below to confirm the endpoint actually serves it.",
        modelEmptyOption: "No speech model (voice replies off)",
        testLabel: "Test speech endpoint",
        testingLabel: "Testing…",
      }}
      conn={spc}
      secret={spcKey}
      models={speechModels.options}
      modelWarning={speechModels.warning}
      probe={speechProbe.state}
      renderOk={(r) => (
        <>
          {r.model} — served ({r.modelCount} models)
        </>
      )}
      onTest={onTestSpeech}
    >
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
    </ConnectionSection>
  );

  const transcriptionTab = (
    <ConnectionSection
      idPrefix="transcription"
      labels={{
        intro:
          "Transcription turns incoming voice messages into text on a dedicated speech-to-text endpoint (whisper.cpp server, speaches, LocalAI…). When no transcription model is set, voice messages are transcribed by the chat model instead — which then must be audio-capable (served with its mmproj).",
        switchLabel: "Separate transcription backend",
        switchHint:
          "Off: transcription is requested from the same backend as the LLM. On: it is served by a different host, which you give below.",
        urlLabel: "Transcription API URL",
        urlHint: "Required — the host serving /v1/audio/transcriptions.",
        urlPlaceholder: "https://whisper.example.com/v1",
        urlMissingError: "A transcription API URL is required.",
        keyLabel: "Transcription API key",
        modelLabel: "Transcription model",
        modelHint:
          "Free text — whisper-class servers often don't list models (e.g. whisper-1, Systran/faster-whisper-large-v3). Empty: voice falls back to the chat model.",
        modelEmptyOption: "No transcription model (chat-model fallback)",
        testLabel: "Test transcription",
        testingLabel: "Testing…",
      }}
      conn={stt}
      secret={sttKey}
      models={transcriptionModels}
      probe={transcriptionProbe.state}
      freeTextModel
      renderOk={(r) => <>{r.model} — endpoint responded</>}
      onTest={onTestTranscription}
    />
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
    { id: "llm", label: "LLM", content: llmTab },
    { id: "embeddings", label: "Embeddings", content: embeddingsTab },
    { id: "images", label: "Images", content: imagesTab },
    { id: "speech", label: "Speech", content: speechTab },
    { id: "transcription", label: "Transcription", content: transcriptionTab },
    { id: "telegram", label: "Telegram", content: telegramTab },
    { id: "general", label: "General", content: generalTab },
    { id: "integrations", label: "Integrations", content: integrationsTab },
    { id: "security", label: "Security", content: <ChangePasswordSection /> },
  ];

  return (
    <form onSubmit={onTest} className="space-y-6">
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
              Cleared {clearedOnSave.join(", ")} — not served by the configured endpoint. Pick
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

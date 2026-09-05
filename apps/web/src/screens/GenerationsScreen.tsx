import { useEffect, useState } from 'react';
import {
  Button,
  EmptyState,
  Field,
  GenerationCard,
  Input,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  TextArea,
  IconImage,
  IconSparkle,
} from '@meridian/ui';
import type { GenerationJob } from '@meridian/shared';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

type Mode = 'image' | 'video' | 'speech';

/**
 * The generation workspace: parameters on the left, results as a canvas.
 *
 * Generation is asynchronous by nature — an image takes seconds and a video can
 * take minutes — so everything here is a job. A refresh never loses work that
 * is already running.
 */
export function GenerationsScreen(): React.JSX.Element {
  const generations = useStore((s) => s.generations);
  const refreshGenerations = useStore((s) => s.refreshGenerations);
  const toast = useStore((s) => s.toast);

  const [mode, setMode] = useState<Mode>('image');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [seed, setSeed] = useState('');
  const [steps, setSteps] = useState(28);
  const [durationSec, setDurationSec] = useState(5);
  const [voice, setVoice] = useState('alloy');
  const [busy, setBusy] = useState(false);
  const [ratios, setRatios] = useState<string[]>(['1:1', '16:9', '9:16', '4:3', '3:2']);

  useEffect(() => {
    void api
      .generations()
      .then((r) => {
        setRatios(r.aspectRatios);
        useStore.setState({ generations: r.jobs });
      })
      .catch(() => undefined);
  }, []);

  const submit = async (): Promise<void> => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const base = { prompt: prompt.trim(), negativePrompt: negativePrompt.trim() || undefined, seed: seed ? Number(seed) : null };
      if (mode === 'image') await api.generateImage({ ...base, aspectRatio, steps });
      else if (mode === 'video') await api.generateVideo({ ...base, aspectRatio, durationSec });
      else await api.generateSpeech({ text: prompt.trim(), voice });
      await refreshGenerations();
    } catch (e) {
      toast({ level: 'error', message: 'Could not start the generation', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const visible = generations.filter((g) => (mode === 'speech' ? g.modality === 'speech' : g.modality === mode));

  return (
    <Screen title="Generations" subtitle="Image, video and speech, routed through the same pools and fallback as everything else." padded={false}>
      <div className="gen">
        <aside className="gen__params mrd-scroll">
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[
              { value: 'image', label: 'Image' },
              { value: 'video', label: 'Video' },
              { value: 'speech', label: 'Speech' },
            ]}
          />

          <Field label={mode === 'speech' ? 'Text' : 'Prompt'}>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              rows={5}
              placeholder={mode === 'speech' ? 'What should it say?' : 'Describe what you want to see…'}
            />
          </Field>

          {mode !== 'speech' && (
            <>
              <Field label="Negative prompt" description="What to avoid. Not every model honours it.">
                <TextArea value={negativePrompt} onChange={(e) => setNegativePrompt(e.currentTarget.value)} rows={2} />
              </Field>
              <Field label="Aspect ratio">
                <Select value={aspectRatio} onChange={(e) => setAspectRatio(e.currentTarget.value)}>
                  {ratios.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Seed" description="Leave empty for a new result each time.">
                <Input value={seed} onChange={(e) => setSeed(e.currentTarget.value)} placeholder="random" inputMode="numeric" />
              </Field>
            </>
          )}

          {mode === 'image' && (
            <Field label={`Steps: ${steps}`} description="More steps take longer and are not always better.">
              <Slider min={4} max={60} value={steps} onValueChange={setSteps} aria-label="Steps" />
            </Field>
          )}

          {mode === 'video' && (
            <Field label={`Duration: ${durationSec}s`}>
              <Slider min={2} max={12} value={durationSec} onValueChange={setDurationSec} aria-label="Duration in seconds" />
            </Field>
          )}

          {mode === 'speech' && (
            <Field label="Voice">
              <Input value={voice} onChange={(e) => setVoice(e.currentTarget.value)} />
            </Field>
          )}

          <Button variant="primary" fullWidth icon={<IconSparkle />} loading={busy} disabled={!prompt.trim()} onClick={() => void submit()}>
            Generate
          </Button>
          <p className="mrd-caption">
            Routed through the {mode} pool. Free providers are preferred; nothing spends money unless you have enabled paid
            routing.
          </p>
        </aside>

        <div className="gen__canvas mrd-scroll">
          {visible.length === 0 ? (
            <EmptyState
              icon={<IconImage />}
              title={`No ${mode} generations yet`}
              description="Results appear here as they finish, newest first, with the model, seed and cost that produced them."
            />
          ) : (
            <div className="app__grid">
              {visible.map((job: GenerationJob) => (
                <GenerationCard
                  key={job.id}
                  job={job}
                  onCancel={() => void api.cancelGeneration(job.id).then(() => refreshGenerations())}
                  onReuse={() => {
                    setPrompt(job.prompt);
                    const s = job.params.seed;
                    if (typeof s === 'number') setSeed(String(s));
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}

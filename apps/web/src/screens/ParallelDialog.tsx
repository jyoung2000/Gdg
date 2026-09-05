import { useState } from 'react';
import { Button, Dialog, Field, Input, Stack, StatusChip, TextArea } from '@meridian/ui';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.js';

interface LaneDraft {
  name: string;
  request: string;
}

/**
 * Run several agents at once, each in its own copy of the workspace.
 *
 * Lanes are never merged automatically: two agents' independent edits combined
 * by a machine is exactly the change a person must look at, so each lane's diff
 * is reported separately along with any overlapping paths.
 */
export function ParallelDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [lanes, setLanes] = useState<LaneDraft[]>([
    { name: 'Frontend', request: '' },
    { name: 'Backend', request: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ conflicts: { path: string; lanes: string[] }[]; runs: unknown[] } | null>(null);

  const update = (i: number, patch: Partial<LaneDraft>): void => {
    setLanes((s) => s.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  const run = async (): Promise<void> => {
    const filled = lanes.filter((l) => l.request.trim());
    if (!filled.length) return;
    setBusy(true);
    try {
      const res = await api.parallel({ workspaceId, lanes: filled, concurrency: Math.min(filled.length, 3) });
      setResult(res);
      toast({ level: 'success', message: `${filled.length} lanes finished` });
    } catch (e) {
      toast({ level: 'error', message: 'Parallel run failed', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title="Run parallel agents" size="lg">
      <Stack direction="column" gap={4}>
        <p className="mrd-secondary">
          Each lane gets its own copy of the workspace, so the agents cannot overwrite one another. Their diffs are reviewed
          separately.
        </p>

        {lanes.map((lane, i) => (
          <Stack key={i} direction="column" gap={2}>
            <Field label={`Lane ${i + 1}`}>
              <Input value={lane.name} onChange={(e) => update(i, { name: e.currentTarget.value })} placeholder="Frontend" />
            </Field>
            <TextArea
              value={lane.request}
              onChange={(e) => update(i, { request: e.currentTarget.value })}
              rows={3}
              placeholder="What should this lane do?"
              aria-label={`Request for lane ${i + 1}`}
            />
          </Stack>
        ))}

        <Stack direction="row" gap={2}>
          <Button variant="tertiary" disabled={lanes.length >= 6} onClick={() => setLanes([...lanes, { name: `Lane ${lanes.length + 1}`, request: '' }])}>
            Add lane
          </Button>
          {lanes.length > 1 && (
            <Button variant="tertiary" onClick={() => setLanes(lanes.slice(0, -1))}>
              Remove last
            </Button>
          )}
        </Stack>

        {result && (
          <section>
            <h3 className="mrd-panel-title">Overlapping files</h3>
            {result.conflicts.length === 0 ? (
              <p className="mrd-secondary">No two lanes touched the same file.</p>
            ) : (
              <Stack direction="column" gap={2}>
                {result.conflicts.map((c) => (
                  <Stack key={c.path} direction="row" gap={2} align="center">
                    <StatusChip status="degraded" label="overlap" size="sm" />
                    <span className="mrd-code mrd-truncate">{c.path}</span>
                    <span className="mrd-caption">{c.lanes.join(', ')}</span>
                  </Stack>
                ))}
              </Stack>
            )}
          </section>
        )}

        <Stack direction="row" gap={2} justify="end">
          <Button variant="tertiary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            Run lanes
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  );
}

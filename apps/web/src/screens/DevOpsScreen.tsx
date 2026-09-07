import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, IconBox, IconPlay, IconRefresh, Input, Select, Stack, StatusChip } from '@meridian/ui';
import { api, type DockerContainerView, type DockerProjectView, type DockerVerifyJobView } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Docker development orchestration.
 *
 * Build → up → healthy → optional tests → a real browser check → guaranteed
 * teardown, run against a workspace's project. The verify job streams its log
 * here and reports a classified failure when it fails, never a bare red.
 */
export function DevOpsScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const workspaces = useStore((s) => s.workspaces);
  const [docker, setDocker] = useState<{ available: boolean; version: string | null; compose: boolean; detail: string | null } | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [project, setProject] = useState<DockerProjectView | null>(null);
  const [isolation, setIsolation] = useState<string>('');
  const [containers, setContainers] = useState<DockerContainerView[]>([]);
  const [expectText, setExpectText] = useState('');
  const [job, setJob] = useState<DockerVerifyJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void api.dockerStatus().then((r) => setDocker(r.docker)).catch(() => setDocker(null));
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const pathFor = useCallback(
    (id: string): string | null => {
      const w = workspaces.find((x) => x.id === id);
      return w ? w.path : null;
    },
    [workspaces],
  );

  const detect = async (id: string) => {
    setWorkspaceId(id);
    setProject(null);
    setContainers([]);
    const path = pathFor(id);
    if (!path) return;
    try {
      const { project: p, isolationName } = await api.dockerDetect(path);
      setProject(p);
      setIsolation(isolationName);
      if (p.kind !== 'none') {
        const { containers: c } = await api.dockerPs(path);
        setContainers(c);
      }
    } catch (e) {
      toast({ level: 'error', message: 'Detection failed', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const verify = async () => {
    const path = pathFor(workspaceId);
    if (!path) return;
    setBusy(true);
    setJob(null);
    try {
      const { jobId } = await api.dockerVerify({ path, browserCheck: expectText ? { expectText } : undefined });
      pollRef.current = window.setInterval(async () => {
        const { job: j } = await api.dockerVerifyJob(jobId);
        setJob(j);
        if (j.status !== 'running') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setBusy(false);
          toast({ level: j.status === 'done' ? 'success' : 'error', message: `Verify ${j.status}` });
        }
      }, 2000);
    } catch (e) {
      setBusy(false);
      toast({ level: 'error', message: 'Verify failed to start', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Screen
      title="DevOps"
      subtitle="Detect, run and verify a workspace's Docker project in isolation"
      actions={
        <Button variant="secondary" size="sm" icon={<IconRefresh />} onClick={() => workspaceId && void detect(workspaceId)} disabled={!workspaceId}>
          Refresh
        </Button>
      }
    >
      <Stack gap={6}>
        <Card>
          <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
            <IconBox />
            <span>Docker</span>
            <StatusChip status={docker?.available ? 'ready' : 'offline'} size="sm" label={docker?.available ? docker.version ?? 'available' : 'unavailable'} />
            {docker?.available && <StatusChip status={docker.compose ? 'ready' : 'degraded'} size="sm" label={docker.compose ? 'compose' : 'no compose'} />}
            {docker?.detail && <span className="mrd-caption mrd-secondary">{docker.detail}</span>}
          </div>
        </Card>

        {!docker?.available ? (
          <EmptyState icon={<IconBox />} title="Docker is not reachable" description={docker?.detail ?? 'The gateway host has no reachable Docker daemon.'} />
        ) : workspaces.length === 0 ? (
          <EmptyState icon={<IconBox />} title="No workspaces" description="Create a workspace with a Dockerfile or compose file to orchestrate it here." />
        ) : (
          <>
            <Card>
              <div className="mrd-hstack" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <Select value={workspaceId} onChange={(e) => void detect(e.target.value)} aria-label="Workspace" placeholder="Select a workspace…">
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </Select>
                {project && (
                  <>
                    <Badge>{project.kind}</Badge>
                    {project.services.length > 0 && <span className="mrd-caption mrd-secondary">{project.services.join(', ')}</span>}
                  </>
                )}
              </div>
              {isolation && <p className="mrd-caption mrd-secondary" style={{ marginTop: 'var(--space-2)' }}>Isolation namespace: <span className="mrd-code">{isolation}</span></p>}
            </Card>

            {project && project.kind === 'none' && (
              <EmptyState icon={<IconBox />} title="No Docker project" description="This workspace has no Dockerfile or compose file." />
            )}

            {project && project.kind !== 'none' && (
              <>
                {containers.length > 0 && (
                  <Card>
                    <h3 className="mrd-heading">Containers</h3>
                    <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                      {containers.map((c) => (
                        <div key={c.id} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                          <StatusChip status={c.state === 'running' ? 'ready' : 'offline'} size="sm" label={c.state} />
                          <span className="mrd-truncate">{c.name}</span>
                          <span className="mrd-caption mrd-secondary">{c.ports}</span>
                        </div>
                      ))}
                    </Stack>
                  </Card>
                )}

                <Card>
                  <Stack gap={3}>
                    <h3 className="mrd-heading">Verification loop</h3>
                    <p className="mrd-caption mrd-secondary">
                      Builds the project, starts it, waits for health, then drives a real browser against it and tears everything down.
                    </p>
                    <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                      <Input placeholder="Expected text on the page (optional)" value={expectText} onChange={(e) => setExpectText(e.target.value)} style={{ flex: 1 }} />
                      <Button icon={<IconPlay />} disabled={busy} onClick={() => void verify()}>
                        {busy ? 'Verifying…' : 'Run verify loop'}
                      </Button>
                    </div>
                  </Stack>
                </Card>

                {job && (
                  <Card>
                    <div className="mrd-hstack" style={{ justifyContent: 'space-between' }}>
                      <h3 className="mrd-heading">
                        Verify job <StatusChip status={job.status === 'done' ? 'ready' : job.status === 'failed' ? 'offline' : 'busy'} size="sm" label={job.status} />
                      </h3>
                      {job.result && <span className="mrd-caption mrd-secondary">{job.result.attempts} attempt(s)</span>}
                    </div>
                    {job.result?.steps && (
                      <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                        {job.result.steps.map((step, i) => (
                          <div key={i} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                            <StatusChip status={step.ok ? 'ready' : 'offline'} size="sm" label={step.name} />
                            <span className="mrd-caption mrd-secondary mrd-truncate">{step.detail}</span>
                            <span className="mrd-caption mrd-secondary" style={{ marginLeft: 'auto' }}>{Math.round(step.durationMs / 100) / 10}s</span>
                          </div>
                        ))}
                      </Stack>
                    )}
                    {job.result?.failure && (
                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <Badge variant="error">{job.result.failure.class}</Badge>
                        <span className="mrd-caption" style={{ marginLeft: 'var(--space-2)' }}>{job.result.failure.detail}</span>
                      </div>
                    )}
                    <details style={{ marginTop: 'var(--space-2)' }}>
                      <summary className="mrd-caption">Log ({job.log.length})</summary>
                      <pre className="mrd-pre mrd-code" style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12 }}>
                        {job.log.join('\n')}
                      </pre>
                    </details>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </Stack>
    </Screen>
  );
}

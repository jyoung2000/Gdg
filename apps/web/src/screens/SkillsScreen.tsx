import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  IconBookmark,
  IconRefresh,
  Input,
  Select,
  Stack,
  StatusChip,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
} from '@meridian/ui';
import {
  api,
  type AssignmentView,
  type EffectiveConfigView,
  type EffectiveExplanations,
  type McpServerView,
  type SkillView,
} from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

/**
 * Skills and grants.
 *
 * The screen is built around one question the user has to be able to answer:
 * "why is this skill active for this model?" So every row shows its
 * inheritance, and the Effective tab shows the resolved answer the runtime
 * will actually use — the same computation, not a re-implementation.
 */
export function SkillsScreen(): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const models = useStore((s) => s.models);
  const [tab, setTab] = useState('skills');
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [scopeModel, setScopeModel] = useState<string>('');
  const [effective, setEffective] = useState<{ config: EffectiveConfigView; explanations: EffectiveExplanations } | null>(null);
  const [editing, setEditing] = useState<SkillView | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, a, m] = await Promise.all([api.skills(), api.assignments(), api.mcpServers().catch(() => ({ servers: [] }))]);
      setSkills(s.skills);
      setAssignments(a.assignments);
      setServers(m.servers);
    } catch (e) {
      toast({ level: 'error', message: 'Could not load skills', detail: e instanceof Error ? e.message : String(e) });
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadEffective = useCallback(async () => {
    try {
      setEffective(await api.effectiveConfig(scopeModel ? { modelId: scopeModel } : {}));
    } catch (e) {
      toast({ level: 'error', message: 'Could not resolve the configuration', detail: e instanceof Error ? e.message : String(e) });
    }
  }, [scopeModel, toast]);

  useEffect(() => {
    if (tab === 'effective') void loadEffective();
  }, [tab, loadEffective]);

  /** The stored decision for one target at one scope, or 'inherit'. */
  const modeAt = (kind: 'skill' | 'mcp', targetId: string, scope: string, scopeId: string | null): string => {
    const hit = assignments.find(
      (a) => a.kind === kind && a.targetId === targetId && a.scope === scope && (a.scopeId ?? null) === scopeId,
    );
    return hit?.mode ?? 'inherit';
  };

  const setMode = async (kind: 'skill' | 'mcp', targetId: string, scope: string, scopeId: string | null, mode: string) => {
    try {
      await api.setAssignment({ kind, targetId, scope, scopeId, mode: mode as 'include' | 'exclude' | 'inherit' });
      await refresh();
      if (tab === 'effective') await loadEffective();
    } catch (e) {
      toast({ level: 'error', message: 'Could not save that assignment', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Screen
      title="Skills & grants"
      subtitle="What each AI is given — globally, per provider, or per model — and why"
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<IconRefresh />} onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            New skill
          </Button>
        </>
      }
    >
      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab value="skills">Skills ({skills.length})</Tab>
          <Tab value="matrix">Assignments</Tab>
          <Tab value="effective">Effective config</Tab>
        </TabList>

        <TabPanel value="skills">
          {skills.length === 0 ? (
            <EmptyState icon={<IconBookmark />} title="No skills yet" description="Create one, and assign it globally or to a specific model." />
          ) : (
            <Stack gap={3}>
              {skills.map((s) => (
                <Card key={s.id}>
                  <div className="mrd-hstack" style={{ justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <strong>{s.name}</strong>
                        <Badge>{s.slug}</Badge>
                        {s.source === 'builtin' && <Badge variant="neutral">builtin</Badge>}
                        <span className="mrd-caption mrd-secondary">~{s.estimatedTokens} tokens</span>
                        {s.requiresCapabilities.length > 0 && (
                          <span className="mrd-caption mrd-secondary">needs {s.requiresCapabilities.join(', ')}</span>
                        )}
                      </div>
                      <p className="mrd-caption mrd-secondary" style={{ marginTop: 4 }}>{s.description || s.content.slice(0, 120)}</p>
                    </div>
                    <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                      <Select
                        size="sm"
                        value={modeAt('skill', s.slug, 'global', null)}
                        onChange={(e) => void setMode('skill', s.slug, 'global', null, e.target.value)}
                        aria-label={`Global assignment for ${s.name}`}
                      >
                        <option value="inherit">Global: off</option>
                        <option value="include">Global: on</option>
                        <option value="exclude">Global: excluded</option>
                      </Select>
                      <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="tertiary"
                        onClick={() =>
                          void api
                            .deleteSkill(s.id)
                            .then(refresh)
                            .catch((e: unknown) => toast({ level: 'error', message: 'Delete failed', detail: String(e) }))
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </Stack>
          )}
        </TabPanel>

        <TabPanel value="matrix">
          <Stack gap={4}>
            <Card>
              <Stack gap={3}>
                <h2 className="mrd-heading">Per-model overrides</h2>
                <p className="mrd-caption mrd-secondary">
                  A model-scoped decision beats the global one. Set a skill to “excluded” here to switch it off for this model only —
                  every other model keeps inheriting the global rule.
                </p>
                <Select value={scopeModel} onChange={(e) => setScopeModel(e.target.value)} aria-label="Model" placeholder="Choose a model…">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.providerId})
                    </option>
                  ))}
                </Select>
              </Stack>
            </Card>

            {scopeModel && (
              <>
                <Card>
                  <h3 className="mrd-heading">Skills</h3>
                  <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                    {skills.map((s) => (
                      <div key={s.id} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <span style={{ flex: 1, minWidth: 0 }} className="mrd-truncate">
                          {s.name} <Badge>{modeAt('skill', s.slug, 'global', null) === 'include' ? 'global on' : 'global off'}</Badge>
                        </span>
                        <Select
                          size="sm"
                          value={modeAt('skill', s.slug, 'model', scopeModel)}
                          onChange={(e) => void setMode('skill', s.slug, 'model', scopeModel, e.target.value)}
                          aria-label={`${s.name} for this model`}
                        >
                          <option value="inherit">Inherit</option>
                          <option value="include">On for this model</option>
                          <option value="exclude">Excluded here</option>
                        </Select>
                      </div>
                    ))}
                  </Stack>
                </Card>

                <Card>
                  <h3 className="mrd-heading">MCP servers</h3>
                  {servers.length === 0 ? (
                    <p className="mrd-secondary" style={{ marginTop: 'var(--space-2)' }}>No MCP servers configured yet.</p>
                  ) : (
                    <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                      {servers.map((srv) => (
                        <div key={srv.id} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                          <span style={{ flex: 1, minWidth: 0 }} className="mrd-truncate">
                            {srv.name}{' '}
                            <Badge>{modeAt('mcp', srv.id, 'global', null) === 'include' ? 'global on' : 'global off'}</Badge>
                          </span>
                          <Select
                            size="sm"
                            value={modeAt('mcp', srv.id, 'global', null)}
                            onChange={(e) => void setMode('mcp', srv.id, 'global', null, e.target.value)}
                            aria-label={`${srv.name} globally`}
                          >
                            <option value="inherit">Global: off</option>
                            <option value="include">Global: on</option>
                            <option value="exclude">Global: excluded</option>
                          </Select>
                          <Select
                            size="sm"
                            value={modeAt('mcp', srv.id, 'model', scopeModel)}
                            onChange={(e) => void setMode('mcp', srv.id, 'model', scopeModel, e.target.value)}
                            aria-label={`${srv.name} for this model`}
                          >
                            <option value="inherit">Inherit</option>
                            <option value="include">On here</option>
                            <option value="exclude">Excluded here</option>
                          </Select>
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>
              </>
            )}
          </Stack>
        </TabPanel>

        <TabPanel value="effective">
          <Stack gap={4}>
            <Card>
              <div className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                <Select value={scopeModel} onChange={(e) => setScopeModel(e.target.value)} aria-label="Model" placeholder="Resolve for…">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ({m.providerId})
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" onClick={() => void loadEffective()}>
                  Resolve
                </Button>
              </div>
              <p className="mrd-caption mrd-secondary" style={{ marginTop: 'var(--space-2)' }}>
                This is the same resolution the runtime performs. Whatever is listed as active is what the model is actually sent.
              </p>
            </Card>

            {effective && (
              <>
                {effective.config.warnings.length > 0 && (
                  <Card>
                    <Stack gap={2}>
                      {effective.config.warnings.map((w, i) => (
                        <p key={i} className="mrd-caption" style={{ color: 'var(--color-warning)' }}>{w}</p>
                      ))}
                    </Stack>
                  </Card>
                )}

                <Card>
                  <div className="mrd-hstack" style={{ justifyContent: 'space-between' }}>
                    <h3 className="mrd-heading">Active skills ({effective.config.skills.length})</h3>
                    <span className="mrd-caption mrd-secondary">
                      ~{effective.config.skillTokens.toLocaleString()} tokens
                      {effective.config.contextPressure !== null ? ` · ${Math.round(effective.config.contextPressure * 100)}% of context` : ''}
                    </span>
                  </div>
                  <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                    {effective.config.skills.length === 0 ? (
                      <p className="mrd-secondary">Nothing is active for this model.</p>
                    ) : (
                      effective.config.skills.map((s) => (
                        <div key={s.skill.slug} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                          <StatusChip status="ready" size="sm" label={s.skill.slug} />
                          <span className="mrd-caption mrd-secondary" style={{ flex: 1 }}>
                            {effective.explanations.skills[s.skill.slug]}
                          </span>
                          <span className="mrd-caption mrd-numeric">~{s.skill.estimatedTokens}</span>
                        </div>
                      ))
                    )}
                  </Stack>
                </Card>

                <Card>
                  <h3 className="mrd-heading">Not active ({effective.config.excludedSkills.length})</h3>
                  <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                    {effective.config.excludedSkills.map((r) => (
                      <div key={r.targetId} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <StatusChip status={r.blocked ? 'degraded' : 'unknown'} size="sm" label={r.targetId} />
                        <span className="mrd-caption mrd-secondary" style={{ flex: 1 }}>
                          {effective.explanations.excludedSkills[r.targetId]}
                        </span>
                      </div>
                    ))}
                  </Stack>
                </Card>

                <Card>
                  <h3 className="mrd-heading">MCP servers ({effective.config.mcpServers.length} active)</h3>
                  <Stack gap={2} style={{ marginTop: 'var(--space-2)' }}>
                    {effective.config.mcpServers.map((m) => (
                      <div key={m.serverId} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <StatusChip status="ready" size="sm" label={m.name} />
                        <span className="mrd-caption mrd-secondary">{effective.explanations.mcpServers[m.serverId]}</span>
                      </div>
                    ))}
                    {effective.config.excludedMcpServers.map((r) => (
                      <div key={r.targetId} className="mrd-hstack" style={{ gap: 'var(--space-2)' }}>
                        <StatusChip status={r.blocked ? 'degraded' : 'unknown'} size="sm" label={r.targetId} />
                        <span className="mrd-caption mrd-secondary">{effective.explanations.excludedMcpServers[r.targetId]}</span>
                      </div>
                    ))}
                  </Stack>
                </Card>
              </>
            )}
          </Stack>
        </TabPanel>
      </Tabs>

      {(editing || creating) && (
        <SkillEditor
          skill={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            void refresh();
          }}
        />
      )}
    </Screen>
  );
}

function SkillEditor({ skill, onClose, onSaved }: { skill: SkillView | null; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useStore((s) => s.toast);
  const [slug, setSlug] = useState(skill?.slug ?? '');
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [content, setContent] = useState(skill?.content ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (skill) await api.updateSkill(skill.id, { name, description, content });
      else await api.createSkill({ slug, name, content, description });
      toast({ level: 'success', message: skill ? 'Skill updated' : 'Skill created' });
      onSaved();
    } catch (e) {
      toast({ level: 'error', message: 'Could not save', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={skill ? `Edit ${skill.name}` : 'New skill'}
      description="Skill content is added to the model's system context when this skill resolves as active."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !name || !content || (!skill && !slug)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        {!skill && (
          <Field label="Slug" description="Stable identifier used by assignments; lowercase letters, digits and hyphens.">
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="code-review" />
          </Field>
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Content" description={`Estimated ~${Math.ceil(content.length / 3.7)} tokens, paid on every request this resolves for.`}>
          <TextArea rows={10} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </Stack>
    </Dialog>
  );
}

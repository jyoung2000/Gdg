import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';
import { ProjectManager } from './ProjectManager.js';

/**
 * Projects, as a first-class destination.
 *
 * The same manager the chat composer opens in a dialog, given its own screen so
 * projects are discoverable the way they are in other assistants — a place you
 * go to, not only a dropdown you find. Activating a project here sets it as the
 * chat's context and takes you to the conversation.
 *
 * The active project is shared with Chat through the one place both read: the
 * `meridian.chat.project` key. Writing it here and navigating means the chat
 * mounts with the project already applied.
 */
export function ProjectsScreen(): React.JSX.Element {
  const setScreen = useStore((s) => s.setScreen);
  const toast = useStore((s) => s.toast);

  const readActive = (): string | null => {
    try {
      return localStorage.getItem('meridian.chat.project') || null;
    } catch {
      return null;
    }
  };

  const setActive = (id: string | null): void => {
    try {
      if (id) localStorage.setItem('meridian.chat.project', id);
      else localStorage.removeItem('meridian.chat.project');
    } catch {
      /* preference-only */
    }
  };

  return (
    <Screen title="Projects" subtitle="Folders of files and standing instructions the AI can work from.">
      <ProjectManager
        activeProject={readActive()}
        onActivate={(id) => {
          setActive(id);
          if (id) {
            toast({ level: 'success', message: 'Project active — opening chat' });
            setScreen('chat');
          } else {
            toast({ level: 'info', message: 'Cleared the active project' });
          }
        }}
      />
    </Screen>
  );
}

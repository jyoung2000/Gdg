import { useId, type ReactNode } from 'react';
import { cx } from '../primitives/util.js';

export interface IconProps {
  /** Rendered box in CSS pixels. Every icon is drawn on a 24 grid and scaled. */
  size?: 16 | 20 | 24;
  className?: string;
  /**
   * Set this only when the icon is the sole carrier of its meaning — a status
   * glyph, or a control that has no other label. Titled icons are announced;
   * untitled ones are hidden, so an icon sitting next to its own label is not
   * read out twice.
   */
  title?: string;
}

interface IconRootProps extends IconProps {
  children: ReactNode;
}

function Icon({ size = 16, className, title, children }: IconRootProps): React.JSX.Element {
  // <title> alone is unreliably exposed; wiring it with aria-labelledby is what
  // actually gives the graphic an accessible name across screen readers.
  const titleId = useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={cx('mrd-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      {children}
    </svg>
  );
}

export type IconComponent = (props: IconProps) => React.JSX.Element;

/**
 * The whole family shares one wrapper, so stroke weight, optical size and the
 * accessibility contract are declared once and cannot drift between icons.
 * The artwork is built at module scope because a React element is immutable and
 * every instance of an icon renders exactly the same geometry.
 */
function glyph(name: string, art: ReactNode): IconComponent {
  function Glyph(props: IconProps): React.JSX.Element {
    return <Icon {...props}>{art}</Icon>;
  }
  Glyph.displayName = `Icon${name}`;
  return Glyph;
}

export const IconChevronRight = glyph('ChevronRight', <path d="M9.5 5.5 16 12l-6.5 6.5" />);
export const IconChevronDown = glyph('ChevronDown', <path d="M5.5 9.5 12 16l6.5-6.5" />);
export const IconChevronLeft = glyph('ChevronLeft', <path d="M14.5 5.5 8 12l6.5 6.5" />);
export const IconChevronUp = glyph('ChevronUp', <path d="M5.5 14.5 12 8l6.5 6.5" />);

export const IconArrowRight = glyph(
  'ArrowRight',
  <>
    <path d="M4 12h15.5" />
    <path d="M14.25 6.75 19.5 12l-5.25 5.25" />
  </>,
);
export const IconArrowLeft = glyph(
  'ArrowLeft',
  <>
    <path d="M20 12H4.5" />
    <path d="M9.75 6.75 4.5 12l5.25 5.25" />
  </>,
);
export const IconArrowUp = glyph(
  'ArrowUp',
  <>
    <path d="M12 20V4.5" />
    <path d="M6.75 9.75 12 4.5l5.25 5.25" />
  </>,
);
export const IconArrowDown = glyph(
  'ArrowDown',
  <>
    <path d="M12 4v15.5" />
    <path d="M6.75 14.25 12 19.5l5.25-5.25" />
  </>,
);
export const IconCornerDownLeft = glyph(
  'CornerDownLeft',
  <>
    <path d="M19.75 4.75V12a3 3 0 0 1-3 3H5.25" />
    <path d="M9.5 10.75 5.25 15l4.25 4.25" />
  </>,
);

export const IconSearch = glyph(
  'Search',
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4 4" />
  </>,
);
export const IconPlus = glyph('Plus', <path d="M12 4.5v15M4.5 12h15" />);
export const IconMinus = glyph('Minus', <path d="M4.5 12h15" />);
export const IconClose = glyph('Close', <path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8" />);
export const IconCheck = glyph('Check', <path d="M5 12.5 9.75 17.25 19 7.5" />);
export const IconDash = glyph('Dash', <path d="M7.5 12h9" />);

export const IconCircle = glyph('Circle', <circle cx="12" cy="12" r="8" />);
export const IconCircleDot = glyph(
  'CircleDot',
  <>
    <circle cx="12" cy="12" r="8" />
    {/* Filled, not a second ring: at 16px two concentric hairlines merge. */}
    <circle cx="12" cy="12" r="2.75" fill="currentColor" stroke="none" />
  </>,
);
export const IconCircleSlash = glyph(
  'CircleSlash',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M6.35 17.65 17.65 6.35" />
  </>,
);
export const IconCircleHalf = glyph(
  'CircleHalf',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
  </>,
);

export const IconAlertTriangle = glyph(
  'AlertTriangle',
  <>
    <path d="M12 4.75 20.5 19.25H3.5Z" />
    <path d="M12 10v3.6" />
    <path d="M12 16.4h.01" />
  </>,
);
export const IconAlertCircle = glyph(
  'AlertCircle',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.75v5" />
    <path d="M12 16.1h.01" />
  </>,
);
export const IconInfo = glyph(
  'Info',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 16.25v-5" />
    <path d="M12 8h.01" />
  </>,
);

export const IconSparkle = glyph(
  'Sparkle',
  <>
    <path d="M11 3.5C11 7.6 14.4 11 18.5 11 14.4 11 11 14.4 11 18.5 11 14.4 7.6 11 3.5 11 7.6 11 11 7.6 11 3.5Z" />
    <path d="M18.5 14.5c0 1.66 1.34 3 3 3-1.66 0-3 1.34-3 3 0-1.66-1.34-3-3-3 1.66 0 3-1.34 3-3Z" />
  </>,
);
export const IconBolt = glyph('Bolt', <path d="M13.75 2.75 5.5 13.5h5.25L10.25 21.25 18.5 10.5h-5.25l.5-7.75Z" />);
export const IconZap = glyph(
  'Zap',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12.9 7.5 9.6 12.4h2.7l-.8 4.1 3.4-4.9h-2.7l.7-4.1Z" />
  </>,
);
export const IconClock = glyph(
  'Clock',
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3.25 2" />
  </>,
);
export const IconPlay = glyph('Play', <path d="M7.5 5.25 19 12 7.5 18.75Z" />);
export const IconPause = glyph('Pause', <path d="M9.5 5.5v13M14.5 5.5v13" />);
export const IconStop = glyph('Stop', <rect x="6" y="6" width="12" height="12" rx="2.5" />);
export const IconRefresh = glyph(
  'Refresh',
  <>
    <path d="M5 12a7 7 0 0 1 12-5" />
    <path d="M17 3.5V7h-3.5" />
    <path d="M19 12a7 7 0 0 1-12 5" />
    <path d="M7 20.5V17h3.5" />
  </>,
);
export const IconUndo = glyph(
  'Undo',
  <>
    <path d="M4.5 9.5h9.5a5 5 0 0 1 0 10H9" />
    <path d="M8.5 5.5 4.5 9.5l4 4" />
  </>,
);
export const IconRedo = glyph(
  'Redo',
  <>
    <path d="M19.5 9.5H10a5 5 0 0 0 0 10h5" />
    <path d="M15.5 5.5 19.5 9.5l-4 4" />
  </>,
);
export const IconCopy = glyph(
  'Copy',
  <>
    <path d="M9 15H7.5A2.5 2.5 0 0 1 5 12.5v-5A2.5 2.5 0 0 1 7.5 5h5A2.5 2.5 0 0 1 15 7.5V9" />
    <rect x="9" y="9" width="10" height="10" rx="2.5" />
  </>,
);
export const IconTrash = glyph(
  'Trash',
  <>
    <path d="M4.75 7h14.5" />
    <path d="M9.5 7V5.25A1.25 1.25 0 0 1 10.75 4h2.5a1.25 1.25 0 0 1 1.25 1.25V7" />
    <path d="M6.75 7v11.25a2 2 0 0 0 2 2h6.5a2 2 0 0 0 2-2V7" />
  </>,
);
export const IconPencil = glyph(
  'Pencil',
  <>
    <path d="M16.6 3.4a2.4 2.4 0 0 1 3.4 3.4L8.6 19.2l-4.5 1.1 1.1-4.5L16.6 3.4Z" />
    <path d="m14.9 5.25 3.4 3.4" />
  </>,
);
export const IconDownload = glyph(
  'Download',
  <>
    <path d="M12 3.75v11" />
    <path d="M7.75 10.5 12 14.75l4.25-4.25" />
    <path d="M4.75 16.5v1.75a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V16.5" />
  </>,
);
export const IconUpload = glyph(
  'Upload',
  <>
    <path d="M12 15.25V3.75" />
    <path d="M7.75 8 12 3.75 16.25 8" />
    <path d="M4.75 16.5v1.75a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V16.5" />
  </>,
);
export const IconExternalLink = glyph(
  'ExternalLink',
  <>
    <path d="M13.5 4.5h6v6" />
    <path d="M19.5 4.5 11 13" />
    <path d="M18 14.5v3.75a2.25 2.25 0 0 1-2.25 2.25h-10a2.25 2.25 0 0 1-2.25-2.25v-10A2.25 2.25 0 0 1 5.75 6H9.5" />
  </>,
);
export const IconLink = glyph(
  'Link',
  <>
    <path d="M16.5 13.4 18.9 11a4.2 4.2 0 0 0-5.9-5.9L10.6 7.5" />
    <path d="M7.5 10.6 5.1 13a4.2 4.2 0 0 0 5.9 5.9l2.4-2.4" />
    <path d="M9.4 14.6 14.6 9.4" />
  </>,
);
export const IconLock = glyph(
  'Lock',
  <>
    <rect x="4.75" y="10" width="14.5" height="10.25" rx="2.5" />
    <path d="M8.25 10V7.75a3.75 3.75 0 0 1 7.5 0V10" />
  </>,
);
export const IconUnlock = glyph(
  'Unlock',
  <>
    <rect x="4.75" y="10" width="14.5" height="10.25" rx="2.5" />
    {/* The shackle stops short of the body: an open loop is what reads as unlocked. */}
    <path d="M8.25 10V7.75a3.75 3.75 0 0 1 7.5 0" />
  </>,
);
export const IconKey = glyph(
  'Key',
  <>
    <circle cx="8.25" cy="15.75" r="3.75" />
    <path d="M10.9 13.1 19.75 4.25" />
    <path d="m15.5 8.5 2 2" />
    <path d="m17.75 6.25 1.75 1.75" />
  </>,
);
export const IconShield = glyph(
  'Shield',
  <path d="M12 3.25 4.75 6.25v5.5c0 4.5 3 7.6 7.25 9 4.25-1.4 7.25-4.5 7.25-9v-5.5L12 3.25Z" />,
);
export const IconEye = glyph(
  'Eye',
  <>
    <path d="M2.75 12c2.5-4.17 5.58-6.25 9.25-6.25s6.75 2.08 9.25 6.25c-2.5 4.17-5.58 6.25-9.25 6.25S5.25 16.17 2.75 12Z" />
    <circle cx="12" cy="12" r="2.85" />
  </>,
);
export const IconEyeOff = glyph(
  'EyeOff',
  <>
    <path d="M2.75 12c2.5-4.17 5.58-6.25 9.25-6.25s6.75 2.08 9.25 6.25c-2.5 4.17-5.58 6.25-9.25 6.25S5.25 16.17 2.75 12Z" />
    <circle cx="12" cy="12" r="2.85" />
    <path d="M4.5 4.5 19.5 19.5" />
  </>,
);

export const IconSettings = glyph(
  'Settings',
  <>
    {/* Six teeth rather than eight: at 16px the valleys of an eight-tooth gear
        close up and the whole glyph reads as a filled disc. */}
    <path d="M20.89 9.28A9.3 9.3 0 0 1 20.89 14.72L17.64 13.72A5.9 5.9 0 0 1 16.31 16.02L18.8 18.34A9.3 9.3 0 0 1 14.09 21.06L13.33 17.75A5.9 5.9 0 0 1 10.67 17.75L9.91 21.06A9.3 9.3 0 0 1 5.2 18.34L7.69 16.02A5.9 5.9 0 0 1 6.36 13.72L3.11 14.72A9.3 9.3 0 0 1 3.11 9.28L6.36 10.28A5.9 5.9 0 0 1 7.69 7.98L5.2 5.66A9.3 9.3 0 0 1 9.91 2.94L10.67 6.25A5.9 5.9 0 0 1 13.33 6.25L14.09 2.94A9.3 9.3 0 0 1 18.8 5.66L16.31 7.98A5.9 5.9 0 0 1 17.64 10.28Z" />
    <circle cx="12" cy="12" r="2.9" />
  </>,
);
export const IconSliders = glyph(
  'Sliders',
  <>
    <path d="M3.5 7.5h5.5M13 7.5h7.5" />
    <circle cx="11" cy="7.5" r="2" />
    <path d="M3.5 12h9.5M17 12h3.5" />
    <circle cx="15" cy="12" r="2" />
    <path d="M3.5 16.5h3.5M11 16.5h9.5" />
    <circle cx="9" cy="16.5" r="2" />
  </>,
);
export const IconFilter = glyph('Filter', <path d="M4 5h16l-6.1 7.2v5.3l-3.8 2.35V12.2L4 5Z" />);
export const IconSort = glyph(
  'Sort',
  <>
    <path d="M7.5 19.25V4.75" />
    <path d="M4 8.25 7.5 4.75 11 8.25" />
    <path d="M16.5 4.75v14.5" />
    <path d="M20 15.75 16.5 19.25 13 15.75" />
  </>,
);
export const IconGrid = glyph(
  'Grid',
  <>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </>,
);
export const IconList = glyph(
  'List',
  <>
    <path d="M4.75 7.5h.01M4.75 12h.01M4.75 16.5h.01" />
    <path d="M9 7.5h10.5M9 12h10.5M9 16.5h10.5" />
  </>,
);
export const IconColumns = glyph(
  'Columns',
  <>
    <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.5" />
    <path d="M9.25 4.75v14.5M14.75 4.75v14.5" />
  </>,
);
export const IconSidebar = glyph(
  'Sidebar',
  <>
    <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.5" />
    <path d="M9.5 4.75v14.5" />
  </>,
);
export const IconPanelRight = glyph(
  'PanelRight',
  <>
    <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.5" />
    <path d="M14.5 4.75v14.5" />
  </>,
);
export const IconPanelBottom = glyph(
  'PanelBottom',
  <>
    <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.5" />
    <path d="M3.5 14.5h17" />
  </>,
);
export const IconTerminal = glyph(
  'Terminal',
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2.75" />
    <path d="M7.25 9.75 10 12.25l-2.75 2.5" />
    <path d="M12.5 15.25h4.25" />
  </>,
);
export const IconCode = glyph('Code', <path d="M9 6.5 3.5 12 9 17.5M15 6.5 20.5 12 15 17.5" />);
export const IconFile = glyph(
  'File',
  <>
    <path d="M13.25 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.75L13.25 3.5Z" />
    <path d="M13 3.75V7.5A1.5 1.5 0 0 0 14.5 9h3.75" />
  </>,
);
export const IconFolder = glyph(
  'Folder',
  <path d="M3.75 6.75a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.55.74l1.15 1.42h6.5a2 2 0 0 1 2 2v9.34a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V6.75Z" />,
);
export const IconFolderOpen = glyph(
  'FolderOpen',
  <>
    <path d="M3.75 11.75V6.75a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.55.74l1.15 1.42h6.5a2 2 0 0 1 2 2v2.84" />
    <path d="M4 11.75h16a1 1 0 0 1 .96 1.28l-1.6 5.7a2 2 0 0 1-1.93 1.47H6.57a2 2 0 0 1-1.93-1.47l-1.6-5.7A1 1 0 0 1 4 11.75Z" />
  </>,
);
export const IconGitBranch = glyph(
  'GitBranch',
  <>
    <circle cx="7" cy="6.5" r="2.5" />
    <circle cx="7" cy="17.5" r="2.5" />
    <circle cx="17" cy="8" r="2.5" />
    <path d="M7 9v6" />
    <path d="M17 10.5v1.25A3.25 3.25 0 0 1 13.75 15H7" />
  </>,
);
export const IconGitCommit = glyph(
  'GitCommit',
  <>
    <circle cx="12" cy="12" r="3.25" />
    <path d="M3.5 12h5.25M15.25 12h5.25" />
  </>,
);
export const IconGitPullRequest = glyph(
  'GitPullRequest',
  <>
    <circle cx="7" cy="6.5" r="2.5" />
    <circle cx="7" cy="17.5" r="2.5" />
    <circle cx="17" cy="17.5" r="2.5" />
    <path d="M7 9v6" />
    <path d="M17 15v-4.5A2.5 2.5 0 0 0 14.5 8h-3.25" />
    <path d="M13.5 5.75 11.25 8l2.25 2.25" />
  </>,
);
export const IconCloud = glyph(
  'Cloud',
  <path d="M7.5 18.25a4.5 4.5 0 0 1 1.4-8.2 5.6 5.6 0 0 1 9.3 2.05 3.4 3.4 0 0 1-.7 6.15H7.5Z" />,
);
export const IconServer = glyph(
  'Server',
  <>
    <rect x="3.5" y="4.75" width="17" height="6.5" rx="2" />
    <rect x="3.5" y="12.75" width="17" height="6.5" rx="2" />
    <path d="M7 8h.01M7 16h.01" />
  </>,
);
export const IconCpu = glyph(
  'Cpu',
  <>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <rect x="10" y="10" width="4" height="4" rx="1" />
    <path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5" />
    <path d="M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
  </>,
);
export const IconDatabase = glyph(
  'Database',
  <>
    <ellipse cx="12" cy="6.5" rx="7.25" ry="2.75" />
    <path d="M4.75 6.5v11c0 1.52 3.25 2.75 7.25 2.75s7.25-1.23 7.25-2.75v-11" />
    <path d="M4.75 12c0 1.52 3.25 2.75 7.25 2.75s7.25-1.23 7.25-2.75" />
  </>,
);
export const IconLayers = glyph(
  'Layers',
  <>
    <path d="M12 3.5 20.5 8 12 12.5 3.5 8 12 3.5Z" />
    <path d="M3.5 12 12 16.5 20.5 12" />
    <path d="M3.5 16 12 20.5 20.5 16" />
  </>,
);
export const IconBox = glyph(
  'Box',
  <>
    <path d="M12 3.25 20.25 7.75v8.5L12 20.75 3.75 16.25v-8.5L12 3.25Z" />
    <path d="M3.75 7.75 12 12.25l8.25-4.5" />
    <path d="M12 12.25v8.5" />
  </>,
);

export const IconImage = glyph(
  'Image',
  <>
    <rect x="3.5" y="4.75" width="17" height="14.5" rx="2.75" />
    <circle cx="9" cy="9.75" r="1.75" />
    <path d="M3.75 18.25 9.4 12.6l3.6 3.6 2.65-2.35 4.6 4.15" />
  </>,
);
export const IconVideo = glyph(
  'Video',
  <>
    <rect x="3" y="6" width="12.5" height="12" rx="2.75" />
    <path d="M15.5 10.75 20.5 7.5v9l-5-3.25V10.75Z" />
  </>,
);
export const IconMic = glyph(
  'Mic',
  <>
    <rect x="9" y="3" width="6" height="10.5" rx="3" />
    <path d="M6 11.75v.75a6 6 0 0 0 12 0v-.75" />
    <path d="M12 18.5v2.25" />
    <path d="M8.75 20.75h6.5" />
  </>,
);
export const IconVolume = glyph(
  'Volume',
  <>
    <path d="M3.25 9.75h3.5L12 5.5v13l-5.25-4.25h-3.5A.75.75 0 0 1 2.5 13.5v-3a.75.75 0 0 1 .75-.75Z" />
    <path d="M15.25 9.5a3.5 3.5 0 0 1 0 5" />
    <path d="M17.75 7a7 7 0 0 1 0 10" />
  </>,
);
export const IconWaveform = glyph(
  'Waveform',
  <path d="M4 10v4M7 7.25v9.5M10 5v14M13 8.5v7M16 6.25v11.5M19 10.5v3" />,
);
export const IconMessageSquare = glyph(
  'MessageSquare',
  <path d="M6.25 4h11.5a2.75 2.75 0 0 1 2.75 2.75v7.5A2.75 2.75 0 0 1 17.75 17H11l-4.75 3.5V17a2.75 2.75 0 0 1-2.75-2.75v-7.5A2.75 2.75 0 0 1 6.25 4Z" />,
);
export const IconSend = glyph(
  'Send',
  <>
    <path d="M20.5 3.5 3.5 10.25l7 2.75 2.75 7 7.25-16.5Z" />
    <path d="M10.5 13 20.5 3.5" />
  </>,
);
export const IconPaperclip = glyph(
  'Paperclip',
  <path d="M18 11.5 11.2 18.3a4.6 4.6 0 0 1-6.5-6.5l8.3-8.3a3.1 3.1 0 0 1 4.4 4.4l-8.3 8.3a1.55 1.55 0 0 1-2.2-2.2l7.3-7.3" />,
);
export const IconUser = glyph(
  'User',
  <>
    <circle cx="12" cy="8.5" r="3.75" />
    <path d="M5 19.75a7 7 0 0 1 14 0" />
  </>,
);
export const IconUsers = glyph(
  'Users',
  <>
    <circle cx="9.5" cy="8.75" r="3.5" />
    <path d="M3.25 19.5a6.25 6.25 0 0 1 12.5 0" />
    <path d="M16 5.6a3.5 3.5 0 0 1 0 6.3" />
    <path d="M17.25 14a6.25 6.25 0 0 1 3.5 5.5" />
  </>,
);
export const IconHome = glyph(
  'Home',
  <>
    <path d="M3.75 10.5 12 3.75l8.25 6.75v8.25a1.75 1.75 0 0 1-1.75 1.75h-13a1.75 1.75 0 0 1-1.75-1.75V10.5Z" />
    <path d="M9.5 20.5v-5.25h5v5.25" />
  </>,
);
export const IconCompass = glyph(
  'Compass',
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M15.25 8.75 13.4 13.4 8.75 15.25 10.6 10.6 15.25 8.75Z" />
  </>,
);
export const IconActivity = glyph('Activity', <path d="M3 12.5h3.75L9.25 6l4 12.5 2.5-6h4.25" />);
export const IconBarChart = glyph(
  'BarChart',
  <>
    <rect x="4" y="12.5" width="4.5" height="7.5" rx="1.25" />
    <rect x="9.75" y="8" width="4.5" height="12" rx="1.25" />
    <rect x="15.5" y="5" width="4.5" height="15" rx="1.25" />
  </>,
);
export const IconDollarSign = glyph(
  'DollarSign',
  <>
    <path d="M12 3.25v17.5" />
    <path d="M16.5 7H9.75a3.25 3.25 0 0 0 0 6.5h4.5a3.25 3.25 0 0 1 0 6.5H7.5" />
  </>,
);
export const IconGlobe = glyph(
  'Globe',
  <>
    <circle cx="12" cy="12" r="8.25" />
    <path d="M3.75 12h16.5" />
    <path d="M12 3.75c2.4 2.3 3.75 5.2 3.75 8.25S14.4 18.2 12 20.25c-2.4-2.05-3.75-5.2-3.75-8.25S9.6 6.05 12 3.75Z" />
  </>,
);
export const IconWifi = glyph(
  'Wifi',
  <>
    <path d="M3.5 9.25a13 13 0 0 1 17 0" />
    <path d="M6.75 12.75a8.25 8.25 0 0 1 10.5 0" />
    <path d="M10 16.25a3.4 3.4 0 0 1 4 0" />
    <path d="M12 19.5h.01" />
  </>,
);
export const IconWifiOff = glyph(
  'WifiOff',
  <>
    <path d="M3.5 9.25a13 13 0 0 1 17 0" />
    <path d="M6.75 12.75a8.25 8.25 0 0 1 10.5 0" />
    <path d="M10 16.25a3.4 3.4 0 0 1 4 0" />
    <path d="M12 19.5h.01" />
    <path d="M4.5 4.5 19.5 19.5" />
  </>,
);
export const IconStar = glyph(
  'Star',
  <path d="M12 4.3 14 9.8l5.85.2-4.65 3.6 1.65 5.6L12 15.95 7.15 19.2l1.65-5.6L4.15 10 10 9.8 12 4.3Z" />,
);
export const IconStarFilled = glyph(
  'StarFilled',
  // The filled twin of Star, so a rating never depends on colour alone.
  <path
    d="M12 4.3 14 9.8l5.85.2-4.65 3.6 1.65 5.6L12 15.95 7.15 19.2l1.65-5.6L4.15 10 10 9.8 12 4.3Z"
    fill="currentColor"
  />,
);
export const IconHeart = glyph(
  'Heart',
  <path d="M12 20.4 4.3 12.4a4.7 4.7 0 0 1 6.65-6.65l1.05 1.05 1.05-1.05a4.7 4.7 0 0 1 6.65 6.65L12 20.4Z" />,
);
export const IconBookmark = glyph(
  'Bookmark',
  <path d="M6.25 3.75h11.5a1 1 0 0 1 1 1v15.5L12 16.25 5.25 20.25V4.75a1 1 0 0 1 1-1Z" />,
);
export const IconTag = glyph(
  'Tag',
  <>
    <path d="M11.05 3.75H5.75a2 2 0 0 0-2 2v5.3a2 2 0 0 0 .59 1.41l6.95 6.95a2 2 0 0 0 2.83 0l5.3-5.3a2 2 0 0 0 0-2.83l-6.95-6.95a2 2 0 0 0-1.42-.58Z" />
    <circle cx="7.9" cy="7.9" r="1.35" />
  </>,
);
export const IconFlag = glyph(
  'Flag',
  <>
    <path d="M5.75 4.25v16.25" />
    <path d="M5.75 4.5h12.5l-2.75 4.25L18.25 13H5.75Z" />
  </>,
);

export const IconMenu = glyph('Menu', <path d="M3.75 7.25h16.5M3.75 12h16.5M3.75 16.75h16.5" />);
export const IconMoreHorizontal = glyph('MoreHorizontal', <path d="M6 12h.01M12 12h.01M18 12h.01" />);
export const IconMoreVertical = glyph('MoreVertical', <path d="M12 6h.01M12 12h.01M12 18h.01" />);
export const IconDrag = glyph(
  'Drag',
  <path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01" />,
);
export const IconMaximize = glyph(
  'Maximize',
  <>
    <path d="M9 3.75H5.75a2 2 0 0 0-2 2V9" />
    <path d="M15 3.75h3.25a2 2 0 0 1 2 2V9" />
    <path d="M20.25 15v3.25a2 2 0 0 1-2 2H15" />
    <path d="M9 20.25H5.75a2 2 0 0 1-2-2V15" />
  </>,
);
export const IconMinimize = glyph(
  'Minimize',
  <>
    <path d="M3.75 9H7a2 2 0 0 0 2-2V3.75" />
    <path d="M20.25 9H17a2 2 0 0 1-2-2V3.75" />
    <path d="M15 20.25V17a2 2 0 0 1 2-2h3.25" />
    <path d="M9 20.25V17a2 2 0 0 0-2-2H3.75" />
  </>,
);
export const IconCommand = glyph(
  'Command',
  <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3Z" />,
);
export const IconOption = glyph('Option', <path d="M3.5 5.75h5.5l7.25 12.5h4.25M14.25 5.75h6" />);
export const IconShift = glyph(
  'Shift',
  <path d="M12 3.5 3.75 11.75H8v6.5a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5v-6.5h4.25L12 3.5Z" />,
);
export const IconRobot = glyph(
  'Robot',
  <>
    <rect x="4" y="7.5" width="16" height="12.5" rx="3.25" />
    <path d="M12 4.25v3.25" />
    <path d="M12 3h.01" />
    <path d="M9.25 12.25v1.5M14.75 12.25v1.5" />
    <path d="M9.5 16.75h5" />
  </>,
);
export const IconWrench = glyph(
  'Wrench',
  <path d="M18.1 3.55 14.8 6.85a1.1 1.1 0 0 0 0 1.55l1.1 1.1a1.1 1.1 0 0 0 1.55 0l3.3-3.3a5.75 5.75 0 0 1-7.6 7.6l-6.9 6.9a2.1 2.1 0 0 1-2.97-2.97l6.9-6.9a5.75 5.75 0 0 1 7.6-7.6Z" />,
);
export const IconBeaker = glyph(
  'Beaker',
  <>
    <path d="M9.25 3.75v5.6a2 2 0 0 1-.28 1.02l-4.4 7.4a2 2 0 0 0 1.72 3.02h11.42a2 2 0 0 0 1.72-3.02l-4.4-7.4a2 2 0 0 1-.28-1.02V3.75" />
    <path d="M8 3.75h8" />
    <path d="M6.35 15.5h11.3" />
  </>,
);
export const IconRoute = glyph(
  'Route',
  <>
    <circle cx="6.5" cy="6.5" r="2.75" />
    <circle cx="17.5" cy="17.5" r="2.75" />
    <path d="M9.25 6.5h5.5a2.75 2.75 0 0 1 0 5.5H9.25a2.75 2.75 0 0 0 0 5.5h5.5" />
  </>,
);
export const IconSplit = glyph(
  'Split',
  <>
    <path d="M3.75 12h3a3.5 3.5 0 0 0 2.8-1.4l1.4-1.85a3.5 3.5 0 0 1 2.8-1.4h5" />
    <path d="M3.75 12h3a3.5 3.5 0 0 1 2.8 1.4l1.4 1.85a3.5 3.5 0 0 0 2.8 1.4h5" />
    <path d="M16.9 5.5 18.75 7.35 16.9 9.2" />
    <path d="M16.9 14.8 18.75 16.65 16.9 18.5" />
  </>,
);
export const IconShuffle = glyph(
  'Shuffle',
  <>
    <path d="M3.75 7.25h3a4 4 0 0 1 3.2 1.6l3.6 4.8a4 4 0 0 0 3.2 1.6h3" />
    <path d="M3.75 16.75h3a4 4 0 0 0 3.2-1.6l3.6-4.8a4 4 0 0 1 3.2-1.6h3" />
    <path d="M17.25 4.75 19.75 7.25 17.25 9.75" />
    <path d="M17.25 14.25 19.75 16.75 17.25 19.25" />
  </>,
);

/**
 * The family as data. Declaring it here rather than alongside each icon keeps
 * one ordered source of truth, so a picker can never fall out of step with the
 * exports above.
 */
export const Icons = {
  ChevronRight: IconChevronRight,
  ChevronDown: IconChevronDown,
  ChevronLeft: IconChevronLeft,
  ChevronUp: IconChevronUp,
  ArrowRight: IconArrowRight,
  ArrowLeft: IconArrowLeft,
  ArrowUp: IconArrowUp,
  ArrowDown: IconArrowDown,
  CornerDownLeft: IconCornerDownLeft,
  Search: IconSearch,
  Plus: IconPlus,
  Minus: IconMinus,
  Close: IconClose,
  Check: IconCheck,
  Dash: IconDash,
  Circle: IconCircle,
  CircleDot: IconCircleDot,
  CircleSlash: IconCircleSlash,
  CircleHalf: IconCircleHalf,
  AlertTriangle: IconAlertTriangle,
  AlertCircle: IconAlertCircle,
  Info: IconInfo,
  Sparkle: IconSparkle,
  Bolt: IconBolt,
  Zap: IconZap,
  Clock: IconClock,
  Play: IconPlay,
  Pause: IconPause,
  Stop: IconStop,
  Refresh: IconRefresh,
  Undo: IconUndo,
  Redo: IconRedo,
  Copy: IconCopy,
  Trash: IconTrash,
  Pencil: IconPencil,
  Download: IconDownload,
  Upload: IconUpload,
  ExternalLink: IconExternalLink,
  Link: IconLink,
  Lock: IconLock,
  Unlock: IconUnlock,
  Key: IconKey,
  Shield: IconShield,
  Eye: IconEye,
  EyeOff: IconEyeOff,
  Settings: IconSettings,
  Sliders: IconSliders,
  Filter: IconFilter,
  Sort: IconSort,
  Grid: IconGrid,
  List: IconList,
  Columns: IconColumns,
  Sidebar: IconSidebar,
  PanelRight: IconPanelRight,
  PanelBottom: IconPanelBottom,
  Terminal: IconTerminal,
  Code: IconCode,
  File: IconFile,
  Folder: IconFolder,
  FolderOpen: IconFolderOpen,
  GitBranch: IconGitBranch,
  GitCommit: IconGitCommit,
  GitPullRequest: IconGitPullRequest,
  Cloud: IconCloud,
  Server: IconServer,
  Cpu: IconCpu,
  Database: IconDatabase,
  Layers: IconLayers,
  Box: IconBox,
  Image: IconImage,
  Video: IconVideo,
  Mic: IconMic,
  Volume: IconVolume,
  Waveform: IconWaveform,
  MessageSquare: IconMessageSquare,
  Send: IconSend,
  Paperclip: IconPaperclip,
  User: IconUser,
  Users: IconUsers,
  Home: IconHome,
  Compass: IconCompass,
  Activity: IconActivity,
  BarChart: IconBarChart,
  DollarSign: IconDollarSign,
  Globe: IconGlobe,
  Wifi: IconWifi,
  WifiOff: IconWifiOff,
  Star: IconStar,
  StarFilled: IconStarFilled,
  Heart: IconHeart,
  Bookmark: IconBookmark,
  Tag: IconTag,
  Flag: IconFlag,
  Menu: IconMenu,
  MoreHorizontal: IconMoreHorizontal,
  MoreVertical: IconMoreVertical,
  Drag: IconDrag,
  Maximize: IconMaximize,
  Minimize: IconMinimize,
  Command: IconCommand,
  Option: IconOption,
  Shift: IconShift,
  Robot: IconRobot,
  Wrench: IconWrench,
  Beaker: IconBeaker,
  Route: IconRoute,
  Split: IconSplit,
  Shuffle: IconShuffle,
} satisfies Record<string, IconComponent>;

export type IconName = keyof typeof Icons;

/** Insertion order, which is the order a picker should present them in. */
export const ICON_NAMES: readonly IconName[] = Object.keys(Icons) as IconName[];

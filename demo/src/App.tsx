import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import DdocEditor from '../../package/ddoc-editor';
import type { FontDescriptor } from '../../package/types';
import { Editor, JSONContent } from '@tiptap/react';
import { SecondLevelNav } from './components/second-level-nav/second-level-nav';
import { demoMenuTree } from './components/second-level-nav/menu-tree';
import { deriveCapabilities } from './components/second-level-nav/capabilities';
import { createDemoAppActions } from './components/second-level-nav/demo-app-actions';
import { LinkModal } from './components/LinkModal';

const demoFonts: FontDescriptor[] = [
  {
    name: 'Poppins',
    family: 'Poppins, sans-serif',
    url: 'https://fonts.gstatic.com/s/poppins/v22/pxiEyp8kv8JHgFVrJJfecnFHGPc.woff2',
  },
  {
    name: 'Inter',
    family: 'Inter, sans-serif',
    url: 'https://fonts.gstatic.com/s/inter/v20/UcCo3FwrK3iLTcviYwYZ8UA3.woff2',
  },
];
import {
  Button,
  Tag,
  IconButton,
  LucideIcon,
  toast,
  Toaster,
  TagType,
  DynamicDropdown,
  ThemeToggle,
} from '@fileverse/ui';
import { useMediaQuery } from 'usehooks-ts';
import { IComment } from '../../package/extensions/comment';
import { fromUint8Array } from 'js-base64';
import { crypto as cryptoUtils } from './crypto';
import { collabStore } from './storage/collab-store';
import { docStore } from './storage/doc-store';
import { swarmEnabled, useSwarmStorage } from './storage/swarm-store';
import { SwarmRestoreProgress } from './components/SwarmRestoreProgress';
import { SwarmNotice } from './components/SwarmNotice';
import { primarySwarmCondition } from '../../package/utils/swarm-diagnostics';
import { DocumentVersion } from '../../package/utils/swarm-document-storage';

/**
 * Swarm snapshot envelope: carries the document title alongside the content
 * so a restore on another browser recovers both. Older raw-content
 * snapshots (no envelope) still load.
 */
const packSnapshot = (title: string, content: string): string =>
  JSON.stringify({ __ddoc: 1, title, content });
const unpackSnapshot = (text: string): { title?: string; content: string } => {
  try {
    const v = JSON.parse(text);
    if (v && v.__ddoc === 1 && typeof v.content === 'string') return v;
  } catch {
    // not an envelope — fall through
  }
  return { content: text };
};

/** Keep ?swarmVersion=N in the address bar (shareable) without reloading. */
const syncVersionParam = (n: number | null) => {
  const url = new URL(window.location.href);
  if (n === null) url.searchParams.delete('swarmVersion');
  else url.searchParams.set('swarmVersion', String(n));
  window.history.replaceState(null, '', url.toString());
};

/** Official Swarm mark (ethswarm.org), drawn in the current text color. */
const SwarmIcon = () => (
  <svg
    viewBox="0 0 1115 1115"
    width="12"
    height="12"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M0 665.01V965l260 150 260-150.01V664.96L260 515 0 665.01zM855 515 595 665v299.99L855 1115l260-150.01V664.95L855 515zM817.32 300.27l-129.91-75.25-.13-149.98L557.5 0 297.68 150.01V450L557.5 600l259.82-150V300.27z" />
    <path d="m817.32 300.27 129.91-75.3V75L817.52 0 687.28 75.04l130.24 74.83-.2 150.4z" />
  </svg>
);
import { DocumentStylingPanel } from './DocumentStylingPanel';
import {
  DocumentStyling,
  CollaborationProps,
  CollabState,
  SerializedCommentAnchor,
  CommentMutationMeta,
} from '../../package/types';
import {
  getKeyFromURLParams,
  generateDocId,
  getDocIdFromURL,
  getTabIdFromURL,
  setURLParams,
  buildDocTabURL,
} from './utils';
import { DevBar } from './components/DevBar';
import { DocSwitcher } from './components/DocSwitcher';

function App() {
  // --- Document identity ---
  const [docId] = useState<string>(() => {
    const urlDocId = getDocIdFromURL();
    if (urlDocId) {
      const list = docStore.getDocList();
      if (!list.find((d) => d.id === urlDocId)) {
        docStore.addDoc({
          id: urlDocId,
          title: 'Untitled',
          createdAt: Date.now(),
          lastModifiedAt: Date.now(),
        });
      }
      docStore.setCurrentDocId(urlDocId);
      return urlDocId;
    }

    const storedDocId = docStore.getCurrentDocId();
    if (storedDocId) {
      setURLParams({ doc: storedDocId });
      return storedDocId;
    }

    const newId = generateDocId();
    docStore.addDoc({
      id: newId,
      title: 'Untitled',
      createdAt: Date.now(),
      lastModifiedAt: Date.now(),
    });
    docStore.setCurrentDocId(newId);
    setURLParams({ doc: newId });
    return newId;
  });

  const urlTabId = getTabIdFromURL();

  // Swarm storage (images + document snapshots) — active when
  // VITE_BEE_API_URL is set (see storage/swarm-store.ts).
  const {
    imageUploadFn,
    imageFetchFn,
    docStorage,
    stampHealth,
    nodeState,
    canWrite,
    progress: swarmProgress,
    adoptBatch,
    beeUrl: swarmBeeUrl,
    batchId: swarmBatchId,
    diagnosticsInput,
    recheck: recheckSwarm,
  } = useSwarmStorage(docId);
  const [swarmStatus, setSwarmStatus] = useState<
    | { state: 'off' }
    | { state: 'saving' }
    | { state: 'saved'; version: number }
    | { state: 'error'; message: string }
  >({ state: 'off' });
  // What (if anything) is wrong with Swarm right now, in the user's terms.
  const swarmCondition = swarmEnabled
    ? primarySwarmCondition({
        ...diagnosticsInput,
        lastError:
          swarmStatus.state === 'error' ? swarmStatus.message : undefined,
      })
    : null;
  // Version preview — through the package's versionHistoryState
  // convention: selecting a version re-hydrates the mounted editor in
  // place (no page reload), and the package itself suspends IndexedDB
  // sync and persistence while version mode is on. ?swarmVersion=N
  // deep-links to a version.
  const [versionPreview, setVersionPreview] = useState<{
    index: number;
    /** Unpacked editor content, handed to versionHistoryState. */
    content: string;
    /** Full snapshot envelope, re-saved verbatim on restore. */
    raw: string;
    title?: string;
  } | null>(null);
  // Bumped when leaving version preview so the editor remounts into a
  // fresh live session (mirrors PreviewDdocEditor's own keyed remount).
  const [editorEpoch, setEditorEpoch] = useState(0);
  const pendingVersionParamRef = useRef<number | null>(
    (() => {
      const v = new URLSearchParams(window.location.search).get(
        'swarmVersion',
      );
      return v === null ? null : Number(v);
    })(),
  );
  const [versionList, setVersionList] = useState<DocumentVersion[] | null>(
    null,
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Dropdown rendered in a portal at a fixed position so no toolbar or
  // navbar stacking context can cover it.
  const [versionMenuPos, setVersionMenuPos] = useState<{
    top: number;
    left: number;
  }>({ top: 0, left: 0 });

  const swarmTagRef = useRef<HTMLButtonElement | null>(null);
  const openVersionHistory = useCallback(async () => {
    if (!docStorage) return;
    // Anchor under the Swarm tag when visible, else under the navbar.
    const rect = swarmTagRef.current?.getBoundingClientRect();
    setVersionMenuPos(
      rect
        ? { top: rect.bottom + 4, left: rect.left }
        : { top: 56, left: window.innerWidth / 2 - 120 },
    );
    setVersionsOpen((open) => !open);
    try {
      setVersionList(await docStorage.listDocumentVersions(docId));
    } catch {
      setVersionList([]);
    }
  }, [docStorage, docId]);

  const isOwnerEdSecretSet = import.meta.env.VITE_OWNER_ED_SECRET;
  // --- Persistence ---
  // Use undefined (not null) when no saved content — null has special meaning
  // in use-tab-editor.tsx (it signals "content explicitly not ready yet")
  const [initialContent, setInitialContent] = useState<string | undefined>(
    () => docStore.getContent(docId) || undefined,
  );
  // Restore the latest version from Swarm before the editor mounts when
  // there is no local copy (e.g. same document opened in another browser).
  const [swarmRestoring, setSwarmRestoring] = useState(
    () => swarmEnabled && !docStore.getContent(docId),
  );
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  useEffect(() => {
    if (!swarmRestoring) return;
    // The node answered but has no batch: reads still work, so carry on.
    // Only a node we cannot reach at all ends the restore early.
    if (nodeState.kind === 'unreachable') {
      setRestoreError(nodeState.reason || 'Bee node unreachable');
      return;
    }
    if (!docStorage) return;
    let cancelled = false;
    (async () => {
      try {
        setRestoreError(null);
        const snapshot = await docStorage.loadDocument(docId);
        if (cancelled) return;
        if (snapshot) {
          const { title: restoredTitle, content } = unpackSnapshot(
            snapshot.text,
          );
          setInitialContent(content);
          lastContentRef.current = content;
          if (restoredTitle) {
            setTitle(restoredTitle);
            titleRef.current = restoredTitle;
            docStore.updateDocTitle(docId, restoredTitle);
          }
          setSwarmStatus({ state: 'saved', version: snapshot.feedIndex });
          console.info(
            `Swarm: restored document version ${snapshot.feedIndex}`,
          );
        }
        if (!cancelled) setSwarmRestoring(false);
      } catch (error) {
        console.warn('Swarm restore failed', error);
        // Keep the progress screen up with the reason and a retry, rather
        // than dropping into an empty editor that silently discards the
        // document that may still be out there.
        if (!cancelled) setRestoreError((error as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [swarmRestoring, docStorage, docId, nodeState, restoreAttempt]);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swarmSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Latest known title/content for Swarm envelopes (titles change without a
  // content onChange, and vice versa).
  const titleRef = useRef<string>('Untitled');
  const lastContentRef = useRef<string | null>(docStore.getContent(docId));
  /** Content not yet accepted by Swarm — flushed when writing resumes. */
  const unsavedRef = useRef<string | null>(null);

  /** Load a snapshot and enter version mode — the mounted editor
   *  re-hydrates via versionHistoryState (versionId keys the hydration). */
  const previewVersion = useCallback(
    async (index: number) => {
      if (!docStorage) return;
      try {
        const snapshot = await docStorage.loadDocumentVersion(docId, index);
        if (!snapshot) return;
        const { title: vTitle, content } = unpackSnapshot(snapshot.text);
        setVersionPreview({ index, content, raw: snapshot.text, title: vTitle });
        syncVersionParam(index);
      } catch (error) {
        console.warn('Swarm version load failed', error);
      }
    },
    [docStorage, docId],
  );

  const exitVersionPreview = useCallback(() => {
    setVersionPreview(null);
    syncVersionParam(null);
    // Fresh live session hydrating the latest saved content (edits made
    // since page load live in docStore, not in the mount-time snapshot).
    setInitialContent(docStore.getContent(docId) || undefined);
    setEditorEpoch((e) => e + 1);
  }, [docId]);

  /** Append the previewed snapshot as a new latest version (history is
   *  immutable — restore never rewrites it). */
  const restorePreviewAsLatest = useCallback(async () => {
    if (!docStorage || !versionPreview) return;
    try {
      const version = await docStorage.saveDocument(docId, versionPreview.raw);
      docStore.setContent(docId, versionPreview.content);
      setInitialContent(versionPreview.content);
      lastContentRef.current = versionPreview.content;
      if (versionPreview.title) {
        setTitle(versionPreview.title);
        titleRef.current = versionPreview.title;
        docStore.updateDocTitle(docId, versionPreview.title);
      }
      setSwarmStatus({ state: 'saved', version: version.index });
      setVersionList(null);
    } catch (error) {
      console.error('Swarm restore failed', error);
      setSwarmStatus({
        state: 'error',
        message: (error as Error).message,
      });
    }
    exitVersionPreview();
  }, [docStorage, docId, versionPreview, exitVersionPreview]);

  // Swarm becoming writable again — a batch bought, or a node that came
  // back — must flush whatever was typed meanwhile. Not a one-shot: a node
  // can stop and restart any number of times in a session.
  useEffect(() => {
    if (canWrite && unsavedRef.current) {
      scheduleSwarmSave(unsavedRef.current);
    }
  }, [canWrite, scheduleSwarmSave]);

  // ?swarmVersion=N deep link: enter version preview once storage is ready.
  useEffect(() => {
    const pending = pendingVersionParamRef.current;
    if (pending !== null && docStorage && !swarmRestoring) {
      pendingVersionParamRef.current = null;
      previewVersion(pending);
    }
  }, [docStorage, swarmRestoring, previewVersion]);

  const scheduleSwarmSave = useCallback(
    (content: string) => {
      // Nothing can reach Swarm right now (no batch, or the node stopped):
      // hold the content rather than firing saves that can only fail. The
      // effect above flushes it when Swarm becomes writable again.
      if (!docStorage || versionPreview || !canWrite) {
        lastContentRef.current = content;
        unsavedRef.current = content;
        return;
      }
      lastContentRef.current = content;
      unsavedRef.current = content;
      if (swarmSaveTimeoutRef.current) {
        clearTimeout(swarmSaveTimeoutRef.current);
      }
      swarmSaveTimeoutRef.current = setTimeout(async () => {
        setSwarmStatus({ state: 'saving' });
        try {
          const version = await docStorage.saveDocument(
            docId,
            packSnapshot(titleRef.current, content),
          );
          // Only now is this content durable beyond the browser.
          if (unsavedRef.current === content) unsavedRef.current = null;
          setSwarmStatus({ state: 'saved', version: version.index });
        } catch (error) {
          console.error('Swarm save failed', error);
          setSwarmStatus({
            state: 'error',
            message: (error as Error).message,
          });
        }
      }, 2000);
    },
    [docId, docStorage, versionPreview, canWrite],
  );

  const handleContentChange = useCallback(
    (
      updatedDocContent: string | JSONContent,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _updateChunk: string,
    ) => {
      // Viewing a historical version: never overwrite local or Swarm state
      // (the package also suspends its own persistence in version mode).
      if (versionPreview) return;
      if (typeof updatedDocContent === 'string') {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => {
          docStore.setContent(docId, updatedDocContent);
          setLastSavedAt(Date.now());
        }, 100);

        // Swarm persistence: each (debounced) save is an immutable version
        // on the document's feed.
        scheduleSwarmSave(updatedDocContent);
      }
    },
    [docId, scheduleSwarmSave, versionPreview],
  );

  // --- Tab deep linking ---
  const handleCopyTabLink = useCallback(
    (tabId: string) => {
      const url = buildDocTabURL(docId, tabId);
      navigator.clipboard.writeText(url).then(() => {
        toast({
          title: 'Tab link copied to clipboard',
          variant: 'success',
          toastType: 'mini',
          iconType: 'icon',
        });
      });
    },
    [docId],
  );

  const tabConfig = useMemo(
    () => ({
      defaultTabId: urlTabId,
      onCopyTabLink: handleCopyTabLink,
    }),
    [urlTabId, handleCopyTabLink],
  );

  // --- Dev bar state ---
  const [activeTabInfo, setActiveTabInfo] = useState({
    activeTabId: 'default',
    tabCount: 0,
  });

  const [collabEnabled, setCollabEnabled] = useState(false);
  const [collabStatus, setCollabStatus] = useState<string>('off');
  const [username, setUsername] = useState('username');
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isMediaMax1280px = useMediaQuery('(max-width: 1280px)');
  const [selectedTags, setSelectedTags] = useState<TagType[]>([]);
  const [isCommentSectionOpen, setIsCommentSectionOpen] = useState(false);
  const [isPresentationMode, setIsPresentationMode] = useState(false);
  const [isSplitView, setIsSplitView] = useState(false);
  const [showTOC, setShowTOC] = useState<boolean>(true);
  const [collaborationId, setCollaborationId] = useState<string>('');
  const [collabRoomKey, setCollabRoomKey] = useState<string>('');

  const [characterCount, setCharacterCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [pageCount, setPageCount] = useState(0);

  // --- Title with persistence ---
  const [title, setTitle] = useState(() => {
    const list = docStore.getDocList();
    const doc = list.find((d) => d.id === docId);
    return doc?.title || 'Untitled';
  });

  // Keep the Swarm envelope's title current (initial value + edits).
  useEffect(() => {
    titleRef.current = title;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle);
      docStore.updateDocTitle(docId, newTitle);
      titleRef.current = newTitle;
      // A title edit is a document change too — version it on Swarm.
      if (lastContentRef.current) {
        scheduleSwarmSave(lastContentRef.current);
      }
    },
    [docId, scheduleSwarmSave],
  );

  // Document styling state - starts undefined to allow dark mode to work
  const [documentStyling, setDocumentStyling] = useState<
    DocumentStyling | undefined
  >(undefined);
  const [showStylingControls, setShowStylingControls] = useState(false);

  const [inlineCommentData, setInlineCommentData] = useState({
    inlineCommentText: '',
    highlightedTextContent: '',
    handleClick: false,
  });

  const [zoomLevel, setZoomLevel] = useState<string>('1');
  const [isNavbarVisible, setIsNavbarVisible] = useState(true);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  // Controlled focus mode (D6) — the second-level nav's View menu drives it.
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const isOnline = useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
  );
  const [disableInlineComment, setDisableInlineComment] = useState(false);
  const [isDDocOwner, setIsDDocOwner] = useState(true);
  const [viewerMode, setViewerMode] = useState<
    'suggest' | 'view-only' | undefined
  >(undefined);

  // Single mode picker for the demo navbar — cycles
  // Owner → Viewer/Suggest → Viewer/View-only → Owner.
  const cycleMode = () => {
    if (isDDocOwner) {
      setIsDDocOwner(false);
      setIsPreviewMode(true);
      setViewerMode('suggest');
    } else if (viewerMode === 'suggest') {
      setViewerMode('view-only');
    } else {
      setIsDDocOwner(true);
      setIsPreviewMode(false);
      setViewerMode(undefined);
    }
  };
  const modeIcon = isDDocOwner
    ? 'Crown'
    : viewerMode === 'suggest'
      ? 'PenLine'
      : 'Eye';
  const modeLabel = isDDocOwner
    ? 'Owner'
    : viewerMode === 'suggest'
      ? 'Suggest'
      : 'View-only';
  const nextModeLabel = isDDocOwner
    ? 'Suggest'
    : viewerMode === 'suggest'
      ? 'View-only'
      : 'Owner';
  const [initialCommentAnchors, setInitialCommentAnchors] = useState<
    SerializedCommentAnchor[]
  >([]);

  const searchParams = new URLSearchParams(window.location.search);
  const paramCollaborationId = searchParams.get('collaborationId');
  const paramKey = getKeyFromURLParams(searchParams);
  const [collabIsOwner, setCollabIsOwner] = useState(false);
  const [collabExtras, setCollabExtras] = useState<{
    ownerEdSecret?: string;
    contractAddress?: string;
    ownerAddress?: string;
    isEns?: boolean;
  }>({});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  // Dev affordance: expose the editor handle for automated smoke tests.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__ddoc = editorRef;
  }, []);

  // Poll tab state from Y.Doc for DevBar
  useEffect(() => {
    const interval = setInterval(() => {
      if (!editorRef.current) return;
      try {
        const ydoc = editorRef.current.getYdoc();
        if (!ydoc) return;
        const root = ydoc.getMap('ddocTabs');
        const order = root.get('order');
        const activeTab = root.get('activeTabId');
        if (order && activeTab) {
          setActiveTabInfo({
            activeTabId: activeTab.toString() || 'default',
            tabCount: order.length,
          });
        }
      } catch {
        // Editor not ready yet
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (paramCollaborationId && paramKey) {
      const name = prompt('Whats your username');
      if (!name) return;

      setCollabRoomKey(paramKey);
      setCollaborationId(paramCollaborationId);
      setUsername(name);
      setCollabIsOwner(false);
      setCollabEnabled(true);
    }
  }, [paramCollaborationId, paramKey]);
  //To handle comments from consumer side

  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  const [initialComments, setInitialComment] = useState<IComment[]>([]);

  const handleReplyOnComment = (id: string, reply: IComment) => {
    setInitialComment((prev) =>
      prev.map((comment) => {
        if (comment.id === id) {
          return {
            ...comment,
            replies: [
              ...(comment.replies || []),
              { ...reply, commentIndex: comment.replies?.length },
            ],
          };
        }
        return comment; // Ensure you return the unchanged comment
      }),
    );
  };
  const handleNewComment = (comment: IComment, meta?: CommentMutationMeta) => {
    setInitialComment((prev) => [
      ...prev,
      { ...comment, commentIndex: prev.length, version: '2' },
    ]);

    // Register the serialized anchor for every new comment that came in with
    // anchor positions (both regular comments and suggestions). The package's
    // initialCommentAnchors useEffect resets `commentAnchorsRef.current` to
    // whatever this prop holds whenever it changes — if a regular comment
    // isn't included here, a subsequent suggestion submit (which DOES
    // re-set this state) wipes the regular comment's anchor and its
    // decoration disappears.
    if (comment.id && meta?.anchorFrom && meta?.anchorTo) {
      const anchor: SerializedCommentAnchor = {
        id: comment.id,
        anchorFrom: meta.anchorFrom,
        anchorTo: meta.anchorTo,
        resolved: false,
        deleted: false,
        ...(comment.isSuggestion && {
          isSuggestion: true,
          suggestionType: meta.suggestionType,
          originalContent: meta.originalContent,
          suggestedContent: meta.suggestedContent,
        }),
      };
      setInitialCommentAnchors((prev) => [...prev, anchor]);
    }
  };
  const handleResolveComment = (commentId: string) => {
    setInitialComment(
      initialComments.map((comment) =>
        comment.id === commentId ? { ...comment, resolved: true } : comment,
      ),
    );
  };

  const handleUnresolveComment = (commentId: string) => {
    setInitialComment(
      initialComments.map((comment) =>
        comment.id === commentId ? { ...comment, resolved: false } : comment,
      ),
    );
  };
  const handleDeleteComment = (commentId: string) => {
    setInitialComment(
      initialComments.map((comment) => {
        if (comment.id === commentId) {
          return {
            ...comment,
            deleted: true,
          };
        } else {
          return { ...comment };
        }
      }),
    );
  };

  //To handle comments from consumer side

  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const stored = collabStore.getCollabConf();
    if (stored) {
      setCollabRoomKey(stored.roomKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCollaborationId(stored.roomId || (stored as any).collaborationId);
      setUsername(stored.username);
      setCollabIsOwner(stored.isOwner);
      setCollabExtras({
        ownerEdSecret: stored.ownerEdSecret,
        contractAddress: stored.contractAddress,
        ownerAddress: stored.ownerAddress,
        isEns: stored.isEns,
      });
      setCollabEnabled(true);
    }
  }, []);

  const onToggleCollaboration = async () => {
    const name = prompt('Whats your username');
    if (!name) return;
    const { privateKey } = cryptoUtils.generateKeyPair();

    const newCollabId = crypto.randomUUID();
    const privateKeyBase64 = fromUint8Array(privateKey, true);

    const extras = {
      ownerEdSecret: import.meta.env.VITE_OWNER_ED_SECRET,
      contractAddress: import.meta.env.VITE_COLLAB_CONTRACT_ADDRESS,
      ownerAddress: import.meta.env.VITE_COLLAB_OWNER_ADDRESS,
      isEns: true as const,
    };

    collabStore.setCollabConf({
      roomKey: privateKeyBase64,
      roomId: newCollabId,
      wsUrl: import.meta.env.VITE_COLLAB_WS_URL,
      isOwner: true,
      username: name,
      ...extras,
    });

    setCollabRoomKey(privateKeyBase64);
    setCollaborationId(newCollabId);
    setUsername(name);
    setCollabIsOwner(true);
    setCollabExtras(extras);
    setCollabEnabled(true);

    console.log(
      `${window.location.origin}?collaborationId=${newCollabId}#key=${privateKeyBase64}`,
    );

    await navigator.clipboard.writeText(
      `${window.location.origin}?collaborationId=${newCollabId}#key=${privateKeyBase64}`,
    );

    toast({
      title: 'Collaboration link copied to clipboard',
      variant: 'success',
      toastType: 'mini',
      iconType: 'icon',
    });
  };

  // --- Second-level nav wiring (capability engine, consumer-mirror) ---
  // isCommentUsable: demo has no publish/IPFS-availability concept (unlike
  // the consumer's comments.available/isDocumentPublished), so this derives
  // from the closest equivalents already tracked here: `isOnline` (network,
  // consumer's comments.available proxy) and `!collabEnabled` (RTC gate,
  // consumer's !enableCollaboration). No unpublished-doc gate to mirror.
  const caps = deriveCapabilities({
    isPreviewMode,
    isCollaboratorMode: collabEnabled && !collabIsOwner,
    isDDocOwner,
    isAuthenticated: isConnected,
    isOnline,
    hasSelection: false, // refined inside SecondLevelNav from the registry
    permissionAllowsComment: !disableInlineComment,
    isRtcEnabled: collabEnabled,
    isCommentUsable: isOnline && !collabEnabled,
  });

  const renderNavbar = ({
    editor,
    liveEditor,
  }: {
    editor: JSONContent;
    liveEditor: Editor | null;
  }): JSX.Element => {
    const publishDoc = () => console.log(editor, title);
    const appActions = createDemoAppActions({
      liveEditor,
      exportModal: (format?: string) =>
        editorRef.current?.exportCurrentTabOrOpenExportModal(format),
      exportMarkdown: () =>
        editorRef.current?.exportContentAsMarkDown(title || 'Untitled'),
      onError: (msg) =>
        toast({
          title: 'Error',
          description: msg,
          variant: 'error',
          iconType: 'icon',
        }),
      isFocusMode,
      setIsFocusMode,
      showTOC,
      setShowTOC,
      openCommentsDrawer: () => setCommentDrawerOpen(true),
      canvasCommentsHidden: disableInlineComment,
      toggleCanvasComments: () => setDisableInlineComment((v) => !v),
      isSplitView,
      toggleSplitView: () => setIsSplitView((v: boolean) => !v),
      createTab: () => editorRef.current?.createTab?.(),
      openLinkModal: () => setLinkModalOpen(true),
      toggleStyling: () => setShowStylingControls((v) => !v),
      zoomLevel,
      setZoomLevel,
      documentStyling,
      setDocumentStyling,
      startPresentation: () => setIsPresentationMode(true),
      openVersionHistory,
    });

    return (
      <>
        {/* Split view's markdown pane is the sole input surface — the doc
            menus must not be reachable while it is active. */}
        {!isSplitView && (
          <SecondLevelNav
            tree={demoMenuTree}
            liveEditor={liveEditor}
            caps={caps}
            appActions={appActions}
          />
        )}
        <div className="flex gap-2 items-center">
          <DocSwitcher currentDocId={docId} currentTitle={title} />
          <div className="relative truncate inline-block xl:!max-w-[300px] !max-w-[108px] color-bg-default text-[14px] font-medium leading-[20px]">
            <span className="invisible whitespace-pre">
              {title || 'Untitled'}
            </span>
            <input
              className="focus:outline-none truncate color-bg-default absolute top-0 left-0 right-0 bottom-0 select-text"
              type="text"
              placeholder="Untitled"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
            />
          </div>
          <Tag
            icon="CircleCheck"
            variant="transparent"
            className="h-6 rounded border color-border-default color-text-secondary text-[12px] font-normal hidden xl:flex"
            style={{ backgroundColor: 'hsl(var(--color-bg-secondary))' }}
          >
            {lastSavedAt ? 'Saved' : 'Not saved yet'}
          </Tag>
          {/* Shown as soon as the node answers — including read-only nodes,
              where nothing is ever saved but versions remain browsable. */}
          {(swarmStatus.state !== 'off' ||
            nodeState.kind === 'ready' ||
            nodeState.kind === 'read-only') && (
            <div className="relative hidden xl:block">
              <button
                type="button"
                ref={swarmTagRef}
                onClick={openVersionHistory}
                className="h-6 rounded border color-border-default color-text-secondary text-[12px] font-normal flex items-center gap-1 px-2 cursor-pointer"
                style={{ backgroundColor: 'hsl(var(--color-bg-secondary))' }}
                title={
                  (nodeState.kind === 'read-only'
                    ? `Edits are kept in this browser only — ${nodeState.reason.toLowerCase()}, so nothing is being written to Swarm. Get a postage batch to save. `
                    : '') +
                  (stampHealth
                    ? `Postage stamp ${stampHealth.status} — ${Math.round(stampHealth.utilization * 100)}% full, expires ${stampHealth.expiresAt.toLocaleDateString()}. `
                    : '') +
                  'Click for version history'
                }
              >
                <SwarmIcon />
                {versionPreview
                  ? `Swarm: viewing v${versionPreview.index}`
                  : !canWrite
                    ? 'Swarm: not saving'
                    : swarmStatus.state === 'saving'
                      ? 'Swarm: saving…'
                      : swarmStatus.state === 'saved'
                        ? `Swarm: saved v${swarmStatus.version}`
                        : 'Swarm: save failed'}
                {stampHealth && stampHealth.status !== 'ok'
                  ? ` · stamp ${stampHealth.status}`
                  : ''}
              </button>
              {versionsOpen &&
                createPortal(
                <div
                  className="fixed min-w-56 max-h-72 overflow-y-auto rounded border color-border-default color-bg-default shadow-elevation-3 text-[12px]"
                  style={{
                    backgroundColor: 'hsl(var(--color-bg-default))',
                    top: versionMenuPos.top,
                    left: versionMenuPos.left,
                    zIndex: 99999,
                  }}
                >
                  {versionPreview && (
                    <>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 hover:color-bg-secondary font-medium"
                        onClick={async () => {
                          setVersionsOpen(false);
                          await restorePreviewAsLatest();
                        }}
                      >
                        ⤴ Restore v{versionPreview.index} as latest
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 hover:color-bg-secondary"
                        onClick={() => {
                          setVersionsOpen(false);
                          exitVersionPreview();
                        }}
                      >
                        ← Back to latest
                      </button>
                      <div className="border-t color-border-default" />
                    </>
                  )}
                  {versionList === null && (
                    <div className="px-3 py-2 color-text-secondary">
                      Loading versions…
                    </div>
                  )}
                  {versionList?.length === 0 && (
                    <div className="px-3 py-2 color-text-secondary">
                      No versions yet
                    </div>
                  )}
                  {versionList
                    ?.slice()
                    .reverse()
                    .map((v) => (
                      <button
                        key={v.index}
                        type="button"
                        className="w-full text-left px-3 py-2 hover:color-bg-secondary flex justify-between gap-3"
                        onClick={() => previewVersion(v.index)}
                      >
                        <span>
                          v{v.index}
                          {v.index === versionList[versionList.length - 1].index
                            ? ' (latest)'
                            : ''}
                          {v.index === versionPreview?.index
                            ? ' — viewing'
                            : ''}
                        </span>
                        <span className="color-text-secondary">
                          {new Date(v.timestamp * 1000).toLocaleString()}
                        </span>
                      </button>
                    ))}
                </div>,
                document.body,
              )}
            </div>
          )}
          <div className="w-6 h-6 rounded color-bg-secondary flex justify-center items-center border color-border-default xl:hidden">
            <LucideIcon
              name="BadgeCheck"
              size="sm"
              className="color-text-secondary"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <ThemeToggle />

          {isMediaMax1280px ? (
            <DynamicDropdown
              key="navbar-more-actions"
              align="center"
              sideOffset={10}
              anchorTrigger={
                <IconButton
                  icon={'EllipsisVertical'}
                  variant="ghost"
                  size="md"
                />
              }
              content={
                <div className="flex flex-col gap-1 p-2 w-fit shadow-elevation-3 ">
                  <Button
                    variant={'ghost'}
                    onClick={() => setShowTOC(true)}
                    className="flex justify-start gap-2"
                  >
                    <LucideIcon name="List" size="sm" />
                    Document Outline
                  </Button>
                  <Button
                    variant={'ghost'}
                    onClick={cycleMode}
                    className="flex justify-start gap-2"
                  >
                    <LucideIcon name={modeIcon} size="sm" />
                    {modeLabel}
                  </Button>
                  <Button
                    variant={'ghost'}
                    onClick={() => setDisableInlineComment((v) => !v)}
                    className="flex justify-start gap-2"
                  >
                    <LucideIcon
                      name={disableInlineComment ? 'EyeOff' : 'Eye'}
                      size="sm"
                    />
                    {disableInlineComment
                      ? 'Show inline comments'
                      : 'Hide inline comments'}
                  </Button>
                  <Button
                    variant={'ghost'}
                    onClick={() => {}}
                    className="flex justify-start gap-2"
                  >
                    <LucideIcon name="Share2" size="sm" />
                    Share
                  </Button>
                  <Button
                    variant={'ghost'}
                    onClick={() => setShowStylingControls(!showStylingControls)}
                    className="flex justify-start gap-2"
                  >
                    <LucideIcon name="Palette" size="sm" />
                    Styling
                  </Button>
                </div>
              }
            />
          ) : (
            <>
              <IconButton
                variant={'ghost'}
                icon={modeIcon}
                size="md"
                title={`${modeLabel} mode — click to switch to ${nextModeLabel}`}
                onClick={cycleMode}
              />
              <IconButton
                variant={'ghost'}
                icon="Share2"
                className="flex xl:hidden"
                size="md"
              />
              <IconButton
                variant={'ghost'}
                icon="Palette"
                size="md"
                onClick={() => setShowStylingControls(!showStylingControls)}
              />
            </>
          )}
          <IconButton
            variant={'ghost'}
            icon="MessageSquareText"
            size="md"
            onClick={() => setCommentDrawerOpen((prev) => !prev)}
          />
          {!collabEnabled ? (
            <IconButton
              variant={'ghost'}
              disabled={!isOwnerEdSecretSet}
              icon="Users"
              size="md"
              onClick={onToggleCollaboration}
            />
          ) : (
            <DynamicDropdown
              key="navbar-more-actions"
              align="center"
              sideOffset={10}
              anchorTrigger={
                <IconButton icon={'Users'} variant="ghost" size="md" />
              }
              content={
                <div className="flex flex-col gap-1 p-2 w-fit shadow-elevation-3 ">
                  {collabIsOwner ? (
                    <Button
                      variant={'ghost'}
                      onClick={() => {
                        editorRef.current?.terminateSession();
                        setCollabEnabled(false);
                        setCollaborationId('');
                        setCollabRoomKey('');
                        setUsername('');
                        setCollabIsOwner(false);
                        setCollabExtras({});
                        setCollabStatus('off');
                        collabStore.clearCollabConf();
                      }}
                    >
                      Stop Collaboration
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => {
                      const base_name = 'sussy_baka';
                      const random_number = Math.floor(Math.random() * 1000000);
                      const new_name = `${base_name}_${random_number}`;
                      editorRef.current?.updateCollaboratorName(new_name);
                    }}
                    variant={'ghost'}
                  >
                    Update Collaborator Name
                  </Button>
                </div>
              }
            />
          )}

          <Button
            onClick={publishDoc}
            toggleLeftIcon={true}
            leftIcon="Share2"
            variant={'ghost'}
            className="!min-w-[90px] !px-0 hidden xl:flex"
          >
            Share
          </Button>
          <div className="flex gap-2 px-2 justify-center items-center">
            <LucideIcon name="Farcaster" />
            <div className="flex-col hidden xl:flex">
              <p className="text-heading-xsm">@[username]</p>
              <p className="text-helper-text-sm">Farcaster</p>
            </div>
          </div>
        </div>
      </>
    );
  };

  const handleConnectViaUsername = async (username: string) => {
    setUsername(username);
    setIsConnected(true);
  };

  const onCollaboratorChange = (collaborators: unknown[] | undefined) => {
    console.log('onCollaboratorChange', collaborators);
  };

  const collaboration = useMemo((): CollaborationProps => {
    if (!collabEnabled || !collaborationId || !collabRoomKey) {
      return { enabled: false };
    }
    return {
      enabled: true,
      connection: {
        roomKey: collabRoomKey,
        roomId: collaborationId,
        wsUrl: import.meta.env.VITE_COLLAB_WS_URL,
        isOwner: collabIsOwner,
        ownerEdSecret: collabExtras.ownerEdSecret,
        contractAddress: collabExtras.contractAddress,
        ownerAddress: collabExtras.ownerAddress,
      },
      session: {
        username,
        isEns: collabExtras.isEns,
      },
      services: {
        commitToStorage: undefined,
        fetchFromStorage: undefined,
      },
      on: {
        onStateChange: (state: CollabState) => {
          console.log('onStateChange', state);
          if (state.status === 'syncing') {
            setCollabStatus(
              state.hasUnmergedPeerUpdates ? 'merging' : 'syncing',
            );
          } else {
            setCollabStatus(state.status);
          }
          if (state.status === 'syncing' && state.hasUnmergedPeerUpdates) {
            toast({
              title: 'Syncing all new changes',
              variant: 'info',
              toastType: 'mini',
              iconType: 'icon',
            });
          } else if (state.status === 'reconnecting') {
            toast({
              title: `Reconnecting (${state.attempt}/${state.maxAttempts})...`,
              variant: 'warning',
              toastType: 'mini',
              iconType: 'icon',
            });
          } else if (state.status === 'error') {
            toast({
              title: 'Collaboration error',
              description: state.error.message,
              variant: 'error',
              iconType: 'icon',
            });
          }
        },
        onError: (error) => {
          console.log('onError', error);
          toast({
            title: 'Collaboration error',
            description: error.message,
            variant: 'error',
            iconType: 'icon',
          });
        },
      },
    };
  }, [
    collabEnabled,
    collaborationId,
    collabRoomKey,
    collabIsOwner,
    collabExtras,
    username,
  ]);

  return (
    <div>
      <DocumentStylingPanel
        isOpen={showStylingControls}
        onClose={() => setShowStylingControls(false)}
        documentStyling={documentStyling}
        onStylingChange={setDocumentStyling}
      />
      {/* Sits above the editor, not over it: the document stays usable
          while whatever is wrong with Swarm is spelled out. Covers every
          condition diagnoseSwarm knows about, not just missing postage. */}
      {swarmCondition && swarmBeeUrl && !swarmRestoring && (
        <SwarmNotice
          condition={swarmCondition}
          beeUrl={swarmBeeUrl}
          batchId={swarmBatchId}
          onRetry={recheckSwarm}
          onBatchReady={(id) => {
            adoptBatch(id);
            recheckSwarm();
          }}
        />
      )}
      {swarmRestoring ? (
        <SwarmRestoreProgress
          nodeState={nodeState}
          progress={swarmProgress}
          error={restoreError}
          onSkip={() => {
            setRestoreError(null);
            setSwarmRestoring(false);
          }}
          onRetry={() => {
            setRestoreError(null);
            setRestoreAttempt((n) => n + 1);
          }}
        />
      ) : (
      <DdocEditor
        ref={editorRef}
        /* Stable key while switching versions (versionId re-hydrates the
           mounted editor); epoch bump on preview exit remounts a fresh
           live session — the pattern PreviewDdocEditor uses internally. */
        key={versionPreview ? 'swarm-version-preview' : `live-${editorEpoch}`}
        versionHistoryState={
          versionPreview
            ? {
                enabled: true,
                versionId: `swarm-v${versionPreview.index}`,
                content: versionPreview.content,
              }
            : undefined
        }
        imageUploadFn={imageUploadFn}
        imageFetchFn={imageFetchFn}
        fonts={demoFonts}
        collaboration={collaboration}
        username={username}
        setUsername={setUsername}
        isPreviewMode={isPreviewMode || Boolean(versionPreview)}
        disableInlineComment={disableInlineComment}
        onChange={handleContentChange}
        initialContent={initialContent}
        enableIndexeddbSync={true}
        ddocId={docId}
        // Only consulted at doc creation; existing docs follow their marker.
        preferredSchemaVersion={
          new URLSearchParams(window.location.search).get('v2') === '1'
            ? 2
            : undefined
        }
        tabConfig={tabConfig}
        onError={(error) => {
          toast({
            title: 'Error',
            description: error,
            variant: 'error',
            iconType: 'icon',
          });
        }}
        renderNavbar={renderNavbar}
        ensResolutionUrl={import.meta.env.ENS_RESOLUTION_URL}
        selectedTags={selectedTags}
        setSelectedTags={setSelectedTags}
        isCommentSectionOpen={isCommentSectionOpen}
        setIsCommentSectionOpen={setIsCommentSectionOpen}
        setInlineCommentData={setInlineCommentData}
        inlineCommentData={inlineCommentData}
        commentDrawerOpen={commentDrawerOpen}
        setCommentDrawerOpen={setCommentDrawerOpen}
        isPresentationMode={isPresentationMode}
        setIsPresentationMode={setIsPresentationMode}
        isFocusMode={isFocusMode}
        onFocusModeChange={setIsFocusMode}
        isSplitView={isSplitView}
        setIsSplitView={setIsSplitView}
        zoomLevel={zoomLevel}
        setZoomLevel={setZoomLevel}
        isNavbarVisible={isNavbarVisible}
        setIsNavbarVisible={setIsNavbarVisible}
        onComment={(): void => {}}
        onInlineComment={(): void => {}}
        onMarkdownImport={(): void => {}}
        onMarkdownExport={(): void => {}}
        onPdfExport={(): void => {}}
        onHtmlExport={(): void => {}}
        onTxtExport={(): void => {}}
        onDocxImport={(): void => {}}
        initialComments={initialComments}
        onCommentReply={handleReplyOnComment}
        onNewComment={handleNewComment}
        setInitialComments={setInitialComment}
        onResolveComment={handleResolveComment}
        onUnresolveComment={handleUnresolveComment}
        onDeleteComment={handleDeleteComment}
        showTOC={showTOC}
        setShowTOC={setShowTOC}
        isConnected={isConnected}
        connectViaWallet={async () => {}}
        isLoading={false}
        connectViaUsername={handleConnectViaUsername}
        onCopyHeadingLink={(link: string) => {
          navigator.clipboard.writeText(link);
          // Mirror the consumer (protected-document-context.tsx): the
          // package only supplies the slug; feedback is the host's job.
          toast({
            title: 'Anchor link copied to clipboard',
            toastType: 'mini',
            iconType: 'icon',
            customIcon: 'Link',
          });
        }}
        onCollaboratorChange={onCollaboratorChange}
        documentStyling={documentStyling}
        isDDocOwner={isDDocOwner}
        viewerMode={isDDocOwner ? undefined : viewerMode}
        initialCommentAnchors={initialCommentAnchors}
        setCharacterCount={setCharacterCount}
        setWordCount={setWordCount}
        setPageCount={setPageCount}
      />
      )}
      <LinkModal
        open={linkModalOpen}
        onOpenChange={setLinkModalOpen}
        getEditor={() => editorRef.current?.getEditor()}
        onError={(msg) =>
          toast({
            title: 'Error',
            description: msg,
            variant: 'error',
            iconType: 'icon',
          })
        }
      />
      <Toaster
        position={!isMobile ? 'bottom-right' : 'center-top'}
        duration={3000}
      />
      <DevBar
        pageCount={pageCount}
        docId={docId}
        activeTabId={activeTabInfo.activeTabId}
        tabCount={activeTabInfo.tabCount}
        characterCount={characterCount}
        wordCount={wordCount}
        collabStatus={collabStatus}
        lastSavedAt={lastSavedAt}
      />
    </div>
  );
}

export default App;

import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { api, auth } from '@appdeploy/client';
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Clock3,
  Cloud,
  Code2,
  Database,
  Download,
  File,
  FileAudio,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import './index.css';

type AppUser = {
  userId: string;
  email?: string;
  name?: string;
  picture?: string;
};

type VaultRecord = {
  id: string;
  kind: 'note' | 'json' | 'file';
  title: string;
  name?: string;
  content?: string;
  folder?: string;
  tags?: string[];
  size?: number;
  mimeType?: string;
  expectedChunks?: number;
  uploadedChunks?: number[];
  status?: 'uploading' | 'ready';
  createdAt: string;
  updatedAt: string;
};

type ComposerKind = 'note' | 'json';

const CHUNK_SIZE = 1024 * 1024;

function getErrorMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const candidate = value as {
      message?: string;
      response?: { data?: { error?: string; message?: string } };
    };
    return (
      candidate.response?.data?.error ||
      candidate.response?.data?.message ||
      candidate.message ||
      'Something went wrong. Please try again.'
    );
  }
  return 'Something went wrong. Please try again.';
}

function formatBytes(bytes = 0): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(value?: string): string {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function safeFilename(value: string): string {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .trim()
      .slice(0, 120) || 'untitled'
  );
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error('The selected file could not be read.'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(file);
  });
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function RecordGlyph({
  item,
  large = false,
}: {
  item: VaultRecord;
  large?: boolean;
}) {
  const size = large ? 25 : 20;
  if (item.kind === 'json') return <FileJson size={size} />;
  if (item.kind === 'note') return <FileText size={size} />;
  if (item.mimeType?.startsWith('image/')) return <FileImage size={size} />;
  if (item.mimeType?.startsWith('video/')) return <FileVideo size={size} />;
  if (item.mimeType?.startsWith('audio/')) return <FileAudio size={size} />;
  if (item.mimeType?.includes('json')) return <Code2 size={size} />;
  if (item.mimeType?.includes('pdf') || item.mimeType?.startsWith('text/'))
    return <FileText size={size} />;
  return <File size={size} />;
}

function App() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [records, setRecords] = useState<VaultRecord[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKind, setActiveKind] = useState('all');
  const [activeFolder, setActiveFolder] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerKind, setComposerKind] = useState<ComposerKind>('note');
  const [editing, setEditing] = useState<VaultRecord | null>(null);
  const [selected, setSelected] = useState<VaultRecord | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VaultRecord | null>(null);
  const [form, setForm] = useState({
    title: '',
    content: '',
    folder: '',
    tags: '',
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [toast, setToast] = useState('');
  const [pageError, setPageError] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refreshRecords() {
    setLoadingRecords(true);
    setPageError('');
    try {
      const response = await api.get('/api/records');
      const data = response.data as {
        items: VaultRecord[];
        nextToken?: string | null;
      };
      setRecords(data.items || []);
      setNextToken(data.nextToken || null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setLoadingRecords(false);
    }
  }

  async function loadMore() {
    if (!nextToken || loadingRecords) return;
    setLoadingRecords(true);
    try {
      const response = await api.get('/api/records', { params: { nextToken } });
      const data = response.data as {
        items: VaultRecord[];
        nextToken?: string | null;
      };
      setRecords(current => [...current, ...(data.items || [])]);
      setNextToken(data.nextToken || null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setLoadingRecords(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      try {
        const restored = (await auth.getUser()) as AppUser | null;
        if (!active) return;
        setUser(restored);
        setAuthLoading(false);
        if (restored) await refreshRecords();
      } catch (error) {
        if (!active) return;
        setAuthError(getErrorMessage(error));
        setAuthLoading(false);
      }
    }
    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const folders = useMemo(() => {
    const values = records
      .map(item => item.folder?.trim())
      .filter((value): value is string => Boolean(value));
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
  }, [records]);

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return records
      .filter(item => {
        const kindMatch =
          activeKind === 'all' ||
          (activeKind === 'files' && item.kind === 'file') ||
          (activeKind === 'notes' && item.kind === 'note') ||
          (activeKind === 'data' && item.kind === 'json');
        const folderMatch = !activeFolder || item.folder === activeFolder;
        const searchText = [
          item.title,
          item.name,
          item.folder,
          ...(item.tags || []),
          item.content || '',
        ]
          .join(' ')
          .toLowerCase();
        return (
          kindMatch &&
          folderMatch &&
          (!normalized || searchText.includes(normalized))
        );
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  }, [records, query, activeKind, activeFolder]);

  const counts = useMemo(
    () => ({
      all: records.length,
      files: records.filter(item => item.kind === 'file').length,
      notes: records.filter(item => item.kind === 'note').length,
      data: records.filter(item => item.kind === 'json').length,
    }),
    [records]
  );

  async function signIn() {
    setAuthError('');
    try {
      await auth.signInWithRedirect();
    } catch (error) {
      setAuthError(getErrorMessage(error));
    }
  }

  async function signOut() {
    try {
      await auth.signOut();
      setUser(null);
      setRecords([]);
      setNextToken(null);
      setSelected(null);
      setToast('You have signed out.');
    } catch (error) {
      setToast(getErrorMessage(error));
    }
  }

  function openComposer(kind: ComposerKind, item?: VaultRecord) {
    setComposerKind(kind);
    setEditing(item || null);
    setForm({
      title: item?.title || '',
      content: item?.content || (kind === 'json' ? '{\n  \n}' : ''),
      folder: item?.folder || '',
      tags: (item?.tags || []).join(', '),
    });
    setSelected(null);
    setComposerOpen(true);
  }

  async function saveRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.title.trim()) {
      setToast('Add a title before saving.');
      return;
    }
    if (composerKind === 'json') {
      try {
        JSON.parse(form.content);
      } catch {
        setToast('That JSON is not valid yet. Check the syntax and try again.');
        return;
      }
    }

    const payload = {
      kind: composerKind,
      title: form.title.trim(),
      content: form.content,
      folder: form.folder.trim(),
      tags: form.tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
    };

    setSaving(true);
    try {
      if (editing) {
        await api.put(
          '/api/records/' + encodeURIComponent(editing.id),
          payload
        );
        setToast('Changes saved.');
      } else {
        await api.post('/api/records', payload);
        setToast(
          composerKind === 'note'
            ? 'Note saved to your vault.'
            : 'JSON data saved to your vault.'
        );
      }
      setComposerOpen(false);
      setEditing(null);
      await refreshRecords();
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function uploadSelectedFile(file?: File) {
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadLabel(file.name);
    setPageError('');

    let uploadId = '';
    try {
      const start = await api.post('/api/files/start', {
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        folder: '',
        tags: [],
      });
      uploadId = String(start.data.id);
      const expectedChunks = Number(start.data.expectedChunks);
      const chunkSize = Number(start.data.chunkSize) || CHUNK_SIZE;

      for (let index = 0; index < expectedChunks; index += 1) {
        const part = file.slice(
          index * chunkSize,
          Math.min(file.size, (index + 1) * chunkSize)
        );
        const base64 = await fileToBase64(part);
        await api.post(
          '/api/files/' + encodeURIComponent(uploadId) + '/chunks/' + index,
          { base64 }
        );
        setUploadProgress(Math.round(((index + 1) / expectedChunks) * 100));
      }

      await api.post(
        '/api/files/' + encodeURIComponent(uploadId) + '/complete',
        {}
      );
      setToast('File safely added to your vault.');
      await refreshRecords();
    } catch (error) {
      setToast(
        getErrorMessage(error) +
          ' An incomplete upload may remain in your vault; you can remove it.'
      );
      await refreshRecords();
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadLabel('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function downloadFile(item: VaultRecord) {
    if (item.status !== 'ready') {
      setToast('This upload is not complete yet.');
      return;
    }
    setToast('Preparing ' + item.title + '…');
    try {
      const expected = Number(item.expectedChunks || 0);
      const parts: Uint8Array[] = [];
      let total = 0;

      for (let index = 0; index < expected; index += 1) {
        const response = await api.get(
          '/api/files/' + encodeURIComponent(item.id) + '/chunks/' + index
        );
        const bytes = base64ToBytes(response.data.base64);
        parts.push(bytes);
        total += bytes.length;
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.length;
      }

      const blob = new Blob([merged], {
        type: item.mimeType || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.name || item.title;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setToast('Download ready.');
    } catch (error) {
      setToast(getErrorMessage(error));
    }
  }

  function exportTextRecord(item: VaultRecord) {
    const content = item.content || '';
    const blob = new Blob([content], {
      type:
        item.kind === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      safeFilename(item.title) + (item.kind === 'json' ? '.json' : '.txt');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function exportBackup() {
    setExporting(true);
    setExportProgress(0);
    setPageError('');

    try {
      const all: VaultRecord[] = [];
      let token: string | null = null;
      let pages = 0;

      do {
        const response = token
          ? await api.get('/api/records', { params: { nextToken: token } })
          : await api.get('/api/records');
        const data = response.data as {
          items: VaultRecord[];
          nextToken?: string | null;
        };
        all.push(...(data.items || []));
        token = data.nextToken || null;
        pages += 1;
        if (pages > 200)
          throw new Error(
            'The backup is too large to export in one operation. Export smaller sets separately.'
          );
        setExportProgress(
          Math.min(
            18,
            Math.round((pages / Math.max(pages + (token ? 1 : 0), 1)) * 18)
          )
        );
      } while (token);

      const zip = new JSZip();
      const manifestItems: Record<string, unknown>[] = [];
      const readyFiles = all.filter(
        item => item.kind === 'file' && item.status === 'ready'
      );

      for (let index = 0; index < all.length; index += 1) {
        const item = all[index];
        const metadata = {
          id: item.id,
          kind: item.kind,
          title: item.title,
          name: item.name || null,
          folder: item.folder || '',
          tags: item.tags || [],
          size: item.size || 0,
          mimeType: item.mimeType || null,
          status: item.status || 'ready',
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
        manifestItems.push(metadata);

        if (item.kind === 'note' || item.kind === 'json') {
          const extension = item.kind === 'json' ? '.json' : '.txt';
          zip.file('records/' + item.id + extension, item.content || '');
        } else if (item.status === 'ready') {
          const expected = Number(item.expectedChunks || 0);
          const output = new Uint8Array(Number(item.size || 0));
          let offset = 0;
          for (let part = 0; part < expected; part += 1) {
            const response = await api.get(
              '/api/files/' + encodeURIComponent(item.id) + '/chunks/' + part
            );
            const bytes = base64ToBytes(response.data.base64);
            output.set(bytes, offset);
            offset += bytes.length;
          }
          zip.file(
            'files/' + item.id + '/' + safeFilename(item.name || item.title),
            output
          );
        }
        setExportProgress(
          18 + Math.round(((index + 1) / Math.max(all.length, 1)) * 62)
        );
      }

      zip.file(
        'manifest.json',
        JSON.stringify(
          {
            product: 'DataNest',
            exportedAt: new Date().toISOString(),
            itemCount: all.length,
            readyFileCount: readyFiles.length,
            items: manifestItems,
          },
          null,
          2
        )
      );

      const blob = await zip.generateAsync({ type: 'blob' }, metadata => {
        setExportProgress(80 + Math.round(metadata.percent * 0.2));
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        'datanest-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setToast('Your backup is ready. Keep a copy somewhere safe.');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setExporting(false);
      setExportProgress(0);
    }
  }

  async function removeRecord(item: VaultRecord) {
    setDeleting(true);
    try {
      await api.delete('/api/records/' + encodeURIComponent(item.id));
      setRecords(current => current.filter(record => record.id !== item.id));
      setSelected(null);
      setConfirmDelete(null);
      setToast('Item deleted.');
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  function openItem(item: VaultRecord) {
    setSelected(item);
  }

  const displayName =
    user?.name || user?.email?.split('@')[0] || 'Your account';

  if (authLoading) {
    return (
      <main className="auth-screen">
        <div className="auth-card loading-card">
          <div className="brand-mark">
            <Database size={25} />
          </div>
          <LoaderCircle className="spin" size={24} />
          <p>Opening your private vault…</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-backdrop orb-one" />
        <div className="auth-backdrop orb-two" />
        <section className="auth-card">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Database size={25} />
            </div>
            <span>DataNest</span>
          </div>
          <div className="auth-art">
            <div className="art-ring ring-one" />
            <div className="art-ring ring-two" />
            <div className="art-core">
              <Cloud size={43} />
            </div>
            <div className="floating-chip chip-top">
              <FileText size={15} /> Notes
            </div>
            <div className="floating-chip chip-side">
              <FileJson size={15} /> JSON
            </div>
            <div className="floating-chip chip-bottom">
              <Archive size={15} /> Files
            </div>
          </div>
          <div className="auth-copy">
            <span className="eyebrow">
              <Sparkles size={13} /> YOUR PERSONAL DATA SPACE
            </span>
            <h1>
              Everything you save.
              <br />
              <em>One calm place.</em>
            </h1>
            <p>
              Keep your documents, photos, notes and structured data together.
              Private to your account, accessible wherever you sign in.
            </p>
          </div>
          <button className="primary-button auth-button" onClick={signIn}>
            Sign in or create an account <ArrowUpFromLine size={17} />
          </button>
          {authError && <p className="inline-error">{authError}</p>}
          <div className="auth-foot">
            <span>
              <ShieldCheck size={14} /> Private account storage
            </span>
            <span>Free-plan friendly</span>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <input
        ref={fileInput}
        className="hidden-input"
        type="file"
        onChange={event => void uploadSelectedFile(event.target.files?.[0])}
      />

      <aside className={'sidebar ' + (mobileMenuOpen ? 'sidebar-open' : '')}>
        <div className="sidebar-brand">
          <div className="brand-mark">
            <Database size={22} />
          </div>
          <div>
            <strong>DataNest</strong>
            <span>PERSONAL VAULT</span>
          </div>
          <button
            className="icon-button mobile-close"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <button
            className={
              activeKind === 'all' && !activeFolder
                ? 'nav-item active'
                : 'nav-item'
            }
            onClick={() => {
              setActiveKind('all');
              setActiveFolder('');
              setMobileMenuOpen(false);
            }}
          >
            <LayoutGlyph /> <span>All items</span>
            <small>{counts.all}</small>
          </button>
          <button
            className={activeKind === 'files' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setActiveKind('files');
              setActiveFolder('');
              setMobileMenuOpen(false);
            }}
          >
            <File size={17} />
            <span>Files</span>
            <small>{counts.files}</small>
          </button>
          <button
            className={activeKind === 'notes' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setActiveKind('notes');
              setActiveFolder('');
              setMobileMenuOpen(false);
            }}
          >
            <FileText size={17} />
            <span>Notes</span>
            <small>{counts.notes}</small>
          </button>
          <button
            className={activeKind === 'data' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setActiveKind('data');
              setActiveFolder('');
              setMobileMenuOpen(false);
            }}
          >
            <Code2 size={17} />
            <span>Structured data</span>
            <small>{counts.data}</small>
          </button>
        </nav>

        <div className="sidebar-section-heading">
          <span>FOLDERS</span>
          <span className="folder-count">{folders.length}</span>
        </div>
        <div className="folder-nav">
          {folders.length ? (
            folders.map(folder => (
              <button
                key={folder}
                className={
                  activeFolder === folder ? 'folder-item active' : 'folder-item'
                }
                onClick={() => {
                  setActiveFolder(folder);
                  setActiveKind('all');
                  setMobileMenuOpen(false);
                }}
              >
                <Folder size={16} />
                <span>{folder}</span>
              </button>
            ))
          ) : (
            <p className="folder-empty">Folders you use will appear here.</p>
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="storage-note">
            <div className="storage-note-icon">
              <ShieldCheck size={17} />
            </div>
            <div>
              <strong>Your data stays yours</strong>
              <span>Private to your account</span>
            </div>
          </div>
          <div className="profile-row">
            <div className="avatar">
              {(displayName[0] || 'U').toUpperCase()}
            </div>
            <div className="profile-text">
              <strong>{displayName}</strong>
              <span>Free plan</span>
            </div>
            <button
              className="icon-button"
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu-button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>Workspace</span>
              <span className="breadcrumb-sep">/</span>
              <strong>
                {activeFolder ||
                  (activeKind === 'all'
                    ? 'All items'
                    : activeKind === 'files'
                      ? 'Files'
                      : activeKind === 'notes'
                        ? 'Notes'
                        : 'Structured data')}
              </strong>
            </div>
          </div>
          <div className="topbar-actions">
            <span className="secure-status">
              <span className="secure-dot" /> Private
            </span>
            <button
              className="secondary-button backup-button"
              onClick={() => void exportBackup()}
              disabled={exporting || loadingRecords}
            >
              {exporting ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Archive size={16} />
              )}
              {exporting
                ? 'Preparing ' + exportProgress + '%'
                : 'Export backup'}
            </button>
            <button
              className="primary-button top-create"
              onClick={() => openComposer('note')}
            >
              <Plus size={17} /> New item
            </button>
          </div>
        </header>

        <section className="page-content">
          <div className="welcome-row">
            <div>
              <span className="eyebrow">YOUR DIGITAL SPACE</span>
              <h1>
                {activeFolder || 'Your vault'}
                <span className="title-period">.</span>
              </h1>
              <p>Keep useful things close. Find them when you need them.</p>
            </div>
            <div className="welcome-decoration">
              <div className="decoration-square">
                <Database size={24} />
              </div>
              <div className="decoration-glow" />
            </div>
          </div>

          <div className="quick-stats">
            <div className="stat-card">
              <div className="stat-icon stat-blue">
                <Database size={18} />
              </div>
              <div>
                <span>Loaded items</span>
                <strong>{counts.all}</strong>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-cyan">
                <File size={18} />
              </div>
              <div>
                <span>Files</span>
                <strong>{counts.files}</strong>
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-icon stat-violet">
                <FileText size={18} />
              </div>
              <div>
                <span>Notes & data</span>
                <strong>{counts.notes + counts.data}</strong>
              </div>
            </div>
            <div className="plan-card">
              <div className="plan-icon">
                <Cloud size={19} />
              </div>
              <div>
                <strong>Free cloud vault</strong>
                <span>Usage follows platform limits</span>
              </div>
              <ShieldCheck size={18} className="plan-shield" />
            </div>
          </div>

          <section className="library-section">
            <div className="section-heading">
              <div>
                <h2>Library</h2>
                <p>Your recently saved items</p>
              </div>
              <div className="library-actions">
                <button
                  className="action-button"
                  onClick={() => openComposer('note')}
                >
                  <Plus size={16} /> Note
                </button>
                <button
                  className="action-button"
                  onClick={() => openComposer('json')}
                >
                  <Code2 size={16} /> JSON
                </button>
                <button
                  className="action-button upload-action"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                >
                  <Upload size={16} /> Upload
                </button>
              </div>
            </div>

            <div className="filter-bar">
              <div className="search-box">
                <Search size={17} />
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Search loaded items, tags and folders…"
                />
                {query && (
                  <button
                    className="clear-search"
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
              <div className="filter-label">
                <ChevronDown size={15} />
                <span>{filteredRecords.length} shown</span>
              </div>
            </div>

            {uploading && (
              <div className="progress-panel">
                <div className="progress-icon">
                  <Upload size={17} />
                </div>
                <div className="progress-copy">
                  <strong>Uploading {uploadLabel}</strong>
                  <span>{uploadProgress}% complete · Keep this tab open</span>
                  <div className="progress-track">
                    <span style={{ width: uploadProgress + '%' }} />
                  </div>
                </div>
                <span className="progress-percent">{uploadProgress}%</span>
              </div>
            )}
            {exporting && (
              <div className="progress-panel export-progress">
                <div className="progress-icon">
                  <Archive size={17} />
                </div>
                <div className="progress-copy">
                  <strong>Building your backup</strong>
                  <span>Collecting records and file contents</span>
                  <div className="progress-track">
                    <span style={{ width: exportProgress + '%' }} />
                  </div>
                </div>
                <span className="progress-percent">{exportProgress}%</span>
              </div>
            )}
            {pageError && (
              <div className="error-banner">
                <span>{pageError}</span>
                <button onClick={() => void refreshRecords()}>Retry</button>
              </div>
            )}

            {loadingRecords && records.length === 0 ? (
              <div className="empty-state">
                <LoaderCircle size={25} className="spin" />
                <strong>Loading your vault</strong>
                <span>Retrieving your saved items…</span>
              </div>
            ) : filteredRecords.length ? (
              <div className="record-grid">
                {filteredRecords.map(item => (
                  <article
                    className="record-card"
                    key={item.id}
                    onClick={() => openItem(item)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={event => {
                      if (event.key === 'Enter') openItem(item);
                    }}
                  >
                    <div className="record-card-top">
                      <div
                        className={
                          'record-icon ' +
                          (item.kind === 'file'
                            ? 'file-tone'
                            : item.kind === 'json'
                              ? 'json-tone'
                              : 'note-tone')
                        }
                      >
                        <RecordGlyph item={item} />
                      </div>
                      <button
                        className="more-button"
                        onClick={event => {
                          event.stopPropagation();
                          setSelected(item);
                        }}
                        aria-label="Open item options"
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </div>
                    <div className="record-card-copy">
                      <h3>{item.title}</h3>
                      <p>
                        {item.kind === 'file'
                          ? formatBytes(item.size) +
                            ' · ' +
                            (item.mimeType || 'File')
                          : item.kind === 'json'
                            ? 'Structured data · JSON'
                            : (item.content || '').slice(0, 92) ||
                              'No content yet'}
                      </p>
                    </div>
                    <div className="record-card-bottom">
                      <div className="record-meta">
                        <span>
                          {item.folder ||
                            (item.kind === 'file'
                              ? 'File'
                              : item.kind === 'json'
                                ? 'JSON data'
                                : 'Note')}
                        </span>
                        <i />
                        {formatDate(item.updatedAt)}
                      </div>
                      {item.status === 'uploading' ? (
                        <span className="status-incomplete">Incomplete</span>
                      ) : (
                        <span className="record-ready">
                          <Check size={12} /> Saved
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-illustration">
                  <div>
                    <HardDrive size={30} />
                  </div>
                  <span className="empty-spark spark-a" />
                  <span className="empty-spark spark-b" />
                </div>
                <strong>
                  {query || activeFolder || activeKind !== 'all'
                    ? 'Nothing found here'
                    : 'Your vault is ready'}
                </strong>
                <span>
                  {query || activeFolder || activeKind !== 'all'
                    ? 'Try another search or choose a different section.'
                    : 'Start by uploading a file, writing a note or saving structured data.'}
                </span>
                {!query && activeKind === 'all' && !activeFolder && (
                  <div className="empty-actions">
                    <button
                      className="primary-button"
                      onClick={() => openComposer('note')}
                    >
                      <Plus size={16} /> Create a note
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload size={16} /> Upload a file
                    </button>
                  </div>
                )}
              </div>
            )}

            {nextToken && (
              <div className="load-more-row">
                <button
                  className="secondary-button"
                  onClick={() => void loadMore()}
                  disabled={loadingRecords}
                >
                  {loadingRecords ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <ChevronDown size={16} />
                  )}{' '}
                  Load more items
                </button>
              </div>
            )}
          </section>

          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} /> Your files and records are separated by
              account.
            </span>
            <span>
              Export a backup regularly. Free cloud storage is subject to
              provider limits.
            </span>
          </footer>
        </section>
      </main>

      {mobileMenuOpen && (
        <button
          className="mobile-scrim"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}

      {composerOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setComposerOpen(false);
          }}
        >
          <section className="modal composer-modal">
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  {editing ? 'EDIT ITEM' : 'ADD TO YOUR VAULT'}
                </span>
                <h2>{editing ? 'Update your item' : 'Create something new'}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setComposerOpen(false)}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>
            {!editing && (
              <div className="composer-tabs">
                <button
                  className={
                    composerKind === 'note'
                      ? 'composer-tab active'
                      : 'composer-tab'
                  }
                  onClick={() => {
                    setComposerKind('note');
                    setForm(current => ({ ...current, content: '' }));
                  }}
                >
                  <FileText size={16} /> Note
                </button>
                <button
                  className={
                    composerKind === 'json'
                      ? 'composer-tab active'
                      : 'composer-tab'
                  }
                  onClick={() => {
                    setComposerKind('json');
                    setForm(current => ({ ...current, content: '{\n  \n}' }));
                  }}
                >
                  <FileJson size={16} /> JSON data
                </button>
              </div>
            )}
            <form onSubmit={saveRecord}>
              <label className="field-label">
                Title
                <input
                  autoFocus
                  value={form.title}
                  onChange={event =>
                    setForm(current => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder={
                    composerKind === 'json'
                      ? 'e.g. Customer settings'
                      : 'e.g. Ideas for my project'
                  }
                  maxLength={120}
                  required
                />
              </label>
              <label className="field-label">
                {composerKind === 'json' ? 'JSON content' : 'Your note'}
                <textarea
                  className={composerKind === 'json' ? 'code-textarea' : ''}
                  value={form.content}
                  onChange={event =>
                    setForm(current => ({
                      ...current,
                      content: event.target.value,
                    }))
                  }
                  placeholder={
                    composerKind === 'json'
                      ? '{\n  "project": "My project",\n  "active": true\n}'
                      : 'Write anything you want to keep…'
                  }
                  rows={composerKind === 'json' ? 11 : 8}
                />
              </label>
              <div className="form-row">
                <label className="field-label">
                  Folder <span className="optional-label">Optional</span>
                  <input
                    value={form.folder}
                    onChange={event =>
                      setForm(current => ({
                        ...current,
                        folder: event.target.value,
                      }))
                    }
                    placeholder="e.g. Work, Study, Personal"
                    maxLength={60}
                  />
                </label>
                <label className="field-label">
                  Tags <span className="optional-label">Optional</span>
                  <input
                    value={form.tags}
                    onChange={event =>
                      setForm(current => ({
                        ...current,
                        tags: event.target.value,
                      }))
                    }
                    placeholder="ideas, important, 2026"
                  />
                </label>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setComposerOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={saving}
                >
                  {saving ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  {saving
                    ? 'Saving…'
                    : editing
                      ? 'Save changes'
                      : 'Save to vault'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {selected && (
        <div
          className="modal-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <section className="modal detail-modal">
            <div className="modal-heading">
              <div className="detail-heading-copy">
                <div
                  className={
                    'record-icon detail-icon ' +
                    (selected.kind === 'file'
                      ? 'file-tone'
                      : selected.kind === 'json'
                        ? 'json-tone'
                        : 'note-tone')
                  }
                >
                  <RecordGlyph item={selected} large />
                </div>
                <div>
                  <span className="eyebrow">
                    {selected.kind === 'file'
                      ? 'FILE'
                      : selected.kind === 'json'
                        ? 'STRUCTURED DATA'
                        : 'NOTE'}
                  </span>
                  <h2>{selected.title}</h2>
                </div>
              </div>
              <button
                className="icon-button"
                onClick={() => setSelected(null)}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>
            <div className="detail-meta">
              <span>
                <Clock3 size={14} /> Updated {formatDate(selected.updatedAt)}
              </span>
              {selected.folder && (
                <span>
                  <Folder size={14} /> {selected.folder}
                </span>
              )}
              {selected.kind === 'file' && (
                <span>
                  <HardDrive size={14} /> {formatBytes(selected.size)}
                </span>
              )}
            </div>
            {selected.tags?.length ? (
              <div className="tag-row">
                {selected.tags.map(tag => (
                  <span key={tag}>
                    <Tag size={11} /> {tag}
                  </span>
                ))}
              </div>
            ) : null}
            {selected.kind === 'file' ? (
              <div className="file-detail-panel">
                <div className="file-large-icon">
                  <RecordGlyph item={selected} large />
                </div>
                <strong>{selected.name || selected.title}</strong>
                <span>
                  {selected.mimeType || 'Unknown file type'} ·{' '}
                  {formatBytes(selected.size)}
                </span>
                {selected.status === 'ready' ? (
                  <button
                    className="primary-button"
                    onClick={() => void downloadFile(selected)}
                  >
                    <Download size={16} /> Download original file
                  </button>
                ) : (
                  <div className="warning-note">
                    This upload did not finish. Remove it and upload the file
                    again.
                  </div>
                )}
              </div>
            ) : (
              <div className="detail-content-wrap">
                <pre
                  className={
                    selected.kind === 'json'
                      ? 'detail-content code-content'
                      : 'detail-content'
                  }
                >
                  {selected.kind === 'json'
                    ? (() => {
                        try {
                          return JSON.stringify(
                            JSON.parse(selected.content || ''),
                            null,
                            2
                          );
                        } catch {
                          return selected.content || '';
                        }
                      })()
                    : selected.content}
                </pre>
              </div>
            )}
            <div className="modal-actions detail-actions">
              {selected.kind !== 'file' && (
                <button
                  className="secondary-button"
                  onClick={() => exportTextRecord(selected)}
                >
                  <ArrowDownToLine size={16} /> Export
                </button>
              )}
              {selected.kind !== 'file' && (
                <button
                  className="secondary-button"
                  onClick={() =>
                    openComposer(selected.kind as ComposerKind, selected)
                  }
                >
                  <Pencil size={16} /> Edit
                </button>
              )}
              <button
                className="danger-button"
                onClick={() => setConfirmDelete(selected)}
              >
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </section>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop confirm-backdrop">
          <section className="modal confirm-modal">
            <div className="confirm-symbol">
              <Trash2 size={22} />
            </div>
            <h2>Delete this item?</h2>
            <p>
              <strong>{confirmDelete.title}</strong> will be permanently removed
              from your vault. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
              >
                Keep item
              </button>
              <button
                className="danger-button"
                onClick={() => void removeRecord(confirmDelete)}
                disabled={deleting}
              >
                {deleting ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Trash2 size={16} />
                )}
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && (
        <div className="toast">
          <Check size={16} />
          <span>{toast}</span>
          <button onClick={() => setToast('')} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function LayoutGlyph() {
  return (
    <div className="layout-glyph">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

export default App;

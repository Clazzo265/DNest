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
  HardDrive,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pause,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  BLOB_DOWNLOAD_SAFE_LIMIT,
  type Quota,
  type DownloadProgress,
  type Limits,
  type TransferProgress,
  downloadFile as transferDownload,
  errorMessage,
  fetchVault,
  formatBytes,
  formatDuration,
  reconcileVault,
  safeFilename,
  saveTextFile,
  sweepVault,
  uploadFile,
} from './transfer';
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
  receivedParts?: number;
  receivedBytes?: number;
  status?: 'uploading' | 'ready';
  createdAt: string;
  updatedAt: string;
};

type ComposerKind = 'note' | 'json';

const getErrorMessage = errorMessage;

type TransferJob = {
  key: string;
  name: string;
  size: number;
  progress: TransferProgress | null;
  status: 'queued' | 'active' | 'done' | 'failed' | 'cancelled';
  id?: string;
  message?: string;
};

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
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [activeJob, setActiveJob] = useState('');
  const [quota, setQuota] = useState<Quota | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [downloadState, setDownloadState] = useState<{
    id: string;
    progress: DownloadProgress | null;
  } | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportLabel, setExportLabel] = useState('');
  const [toast, setToast] = useState('');
  const [pageError, setPageError] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const uploadHandle = useRef<ReturnType<typeof uploadFile> | null>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refreshVault() {
    try {
      const state = await fetchVault();
      setQuota(state.quota);
      setLimits(state.limits);
    } catch {
      /* quota display is non-critical; records still work */
    }
  }

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
        if (restored) await Promise.all([refreshRecords(), refreshVault()]);
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

  /**
   * Upload through the concurrent transfer engine. The engine resumes from the
   * server's own part map, so a failed or cancelled upload can be picked up
   * again without re-sending anything that already landed.
   */
  function startTransfer(file: File, resumeId?: string) {
    const key = resumeId || file.name + ':' + file.size + ':' + file.lastModified;
    setUploading(true);
    setActiveJob(key);
    setPageError('');
    setJobs(current => {
      const others = current.filter(job => job.key !== key);
      return [
        {
          key,
          name: file.name,
          size: file.size,
          progress: null,
          status: 'active' as const,
          id: resumeId,
        },
        ...others,
      ].slice(0, 40);
    });

    const handle = uploadFile(file, {
      resumeId,
      onStarted: id => {
        setJobs(current =>
          current.map(job => (job.key === key ? { ...job, id } : job))
        );
      },
      onProgress: progress => {
        setJobs(current =>
          current.map(job => (job.key === key ? { ...job, progress } : job))
        );
      },
      onQuota: next => setQuota(next),
    });
    uploadHandle.current = handle;

    void handle.promise
      .then(async result => {
        setJobs(current =>
          current.map(job =>
            job.key === key ? { ...job, status: 'done', id: result.id } : job
          )
        );
        if (result.quota) setQuota(result.quota);
        setToast(file.name + ' is saved in your vault.');
        await Promise.all([refreshRecords(), refreshVault()]);
      })
      .catch(error => {
        const message = getErrorMessage(error);
        const cancelled = message.toLowerCase().includes('cancel');
        setJobs(current =>
          current.map(job =>
            job.key === key
              ? {
                  ...job,
                  status: cancelled ? 'cancelled' : 'failed',
                  message,
                }
              : job
          )
        );
        if (!cancelled) setPageError(message);
        else setToast('Upload paused. You can resume it from the transfer panel.');
        void refreshRecords();
      })
      .finally(() => {
        setUploading(false);
        setActiveJob('');
        if (fileInput.current) fileInput.current.value = '';
      });
  }

  async function uploadSelectedFiles(files?: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);

    // Validate against the published limits before sending a single byte.
    if (limits) {
      const tooBig = list.find(file => file.size > limits.maxFileSize);
      if (tooBig) {
        setPageError(
          tooBig.name +
            ' is larger than the maximum single file size of ' +
            formatBytes(limits.maxFileSize) +
            '.'
        );
        return;
      }
      const incoming = list.reduce((total, file) => total + file.size, 0);
      if (quota && incoming > quota.remainingBytes) {
        setPageError(
          'These files need ' +
            formatBytes(incoming) +
            ' but only ' +
            formatBytes(quota.remainingBytes) +
            ' is left in your vault. Free up space or upload fewer files.'
        );
        return;
      }
    }

    for (const file of list) {
      startTransfer(file);
    }
  }

  function pauseUpload() {
    uploadHandle.current?.cancel();
    setToast('Stopping the upload. Parts already sent are kept.');
  }

  async function resumeJob(job: TransferJob) {
    if (!job.id) {
      setToast('This upload has no server record to resume from.');
      return;
    }
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setToast('Choose the same file again to resume this upload.');
      return;
    }
    startTransfer(file, job.id);
  }

  async function downloadItem(item: VaultRecord) {
    if (item.status !== 'ready') {
      setToast('This upload has not finished yet.');
      return;
    }
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloadState({ id: item.id, progress: null });
    setPageError('');

    try {
      const mode = await transferDownload(
        {
          id: item.id,
          name: item.name,
          title: item.title,
          size: item.size,
          mimeType: item.mimeType,
        },
        {
          signal: controller.signal,
          onProgress: progress =>
            setDownloadState({ id: item.id, progress }),
        }
      );
      setToast(
        mode === 'streamed'
          ? item.title + ' was written straight to disk.'
          : item.title + ' downloaded.'
      );
    } catch (error) {
      const message = getErrorMessage(error);
      const aborted = String((error as Error)?.name || '') === 'AbortError';
      if (aborted) setToast('Download cancelled.');
      else setPageError(message);
    } finally {
      setDownloadState(null);
      downloadAbort.current = null;
    }
  }

  function cancelDownload() {
    downloadAbort.current?.abort();
  }

  /**
   * Backup export. Files are pulled in bounded batches so a vault containing a
   * large file cannot blow the heap; the manifest is always written even when
   * some file bodies are skipped, so the backup stays a valid index.
   */
  async function exportBackup() {
    setExporting(true);
    setExportProgress(0);
    setExportLabel('Collecting records');
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
        if (pages > 2_000)
          throw new Error(
            'This vault has too many items to index in one export. Export folders separately.'
          );
        setExportProgress(Math.min(10, Math.round((pages / 50) * 10)));
      } while (token);

      const zip = new JSZip();
      const manifestItems: Record<string, unknown>[] = [];
      const skipped: { id: string; reason: string }[] = [];
      const totalBytes = all.reduce(
        (sum, item) => sum + (Number(item.size) || 0),
        0
      );
      let processed = 0;

      for (const item of all) {
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
          // Guard rail: the ZIP is built in client memory, so very large files
          // are listed in the manifest instead of silently killing the tab.
          if ((Number(item.size) || 0) > BLOB_DOWNLOAD_SAFE_LIMIT) {
            skipped.push({
              id: item.id,
              reason: 'larger than the in-browser backup limit',
            });
          } else {
            const statusResponse = await api.get(
              '/api/files/' + encodeURIComponent(item.id) + '/status',
              { params: { from: '0', limit: '1' } }
            );
            const partsTotal = Number(statusResponse.data.expectedChunks) || 0;
            const output = new Uint8Array(Number(item.size) || 0);
            let offset = 0;
            for (let start = 0; start < partsTotal; start += 8) {
              const indexes: number[] = [];
              for (
                let index = start;
                index < Math.min(partsTotal, start + 8);
                index += 1
              ) {
                indexes.push(index);
              }
              const response = await api.post(
                '/api/files/' + encodeURIComponent(item.id) + '/chunks/read',
                { indexes }
              );
              for (const part of (response.data as {
                parts: { base64: string }[];
              }).parts) {
                const binary = atob(part.base64);
                for (let index = 0; index < binary.length; index += 1) {
                  output[offset + index] = binary.charCodeAt(index);
                }
                offset += binary.length;
              }
              setExportLabel('Packing ' + item.title);
              setExportProgress(
                10 +
                  Math.round(
                    (Math.min(offset, Number(item.size) || 1) /
                      Math.max(Number(item.size) || 1, 1)) *
                      60 *
                      (1 / Math.max(all.length, 1))
                  )
              );
            }
            zip.file(
              'files/' + item.id + '/' + safeFilename(item.name || item.title),
              output
            );
          }
        }

        processed += 1;
        setExportProgress(10 + Math.round((processed / Math.max(all.length, 1)) * 60));
      }

      zip.file(
        'manifest.json',
        JSON.stringify(
          {
            product: 'DataNest',
            exportedAt: new Date().toISOString(),
            itemCount: all.length,
            totalBytes,
            quota: quota
              ? {
                  quotaBytes: quota.quotaBytes,
                  usedBytes: quota.usedBytes,
                }
              : null,
            skipped,
            items: manifestItems,
          },
          null,
          2
        )
      );

      setExportLabel('Compressing archive');
      const blob = await zip.generateAsync({ type: 'blob' }, metadata => {
        setExportProgress(70 + Math.round(metadata.percent * 0.3));
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        'datanest-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setToast(
        skipped.length
          ? 'Backup ready. ' +
              skipped.length +
              ' large file(s) are listed in the manifest only.'
          : 'Your backup is ready. Keep a copy somewhere safe.'
      );
    } catch (error) {
      setToast(getErrorMessage(error));
    } finally {
      setExporting(false);
      setExportProgress(0);
      setExportLabel('');
    }
  }

  function exportTextRecord(item: VaultRecord) {
    const extension = item.kind === 'json' ? '.json' : '.txt';
    saveTextFile(
      safeFilename(item.title) + extension,
      item.content || ''
    );
  }

  async function runMaintenance(action: 'reconcile' | 'sweep') {
    setMaintenanceBusy(action);
    try {
      if (action === 'reconcile') {
        const result = await reconcileVault();
        setQuota(result.quota);
        setToast(
          'Usage verified against stored parts (' +
            result.parts.toLocaleString() +
            ' parts).'
        );
      } else {
        const result = await sweepVault();
        setQuota(result.quota);
        setToast(
          result.reclaimed
            ? 'Reclaimed ' +
                formatBytes(result.reclaimedBytes) +
                ' from ' +
                result.reclaimed +
                ' abandoned upload(s).'
            : 'No abandoned uploads to clean up.'
        );
        await refreshRecords();
      }
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setMaintenanceBusy('');
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
        multiple
        onChange={event => void uploadSelectedFiles(event.target.files)}
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
              <strong>{quota ? formatBytes(quota.usedBytes) + ' of 1 TB' : '1 TB vault'}</strong>
              <span>
                {quota
                  ? formatBytes(quota.remainingBytes) + ' available'
                  : 'Private to your account'}
              </span>
            </div>
          </div>
          {quota && (
            <div className="quota-meter" aria-label="Vault usage">
              <div className="quota-meter-track">
                <span
                  className={
                    quota.percentUsed > 90 ? 'quota-fill danger' : 'quota-fill'
                  }
                  style={{ width: Math.max(1, quota.percentUsed) + '%' }}
                />
              </div>
              <div className="quota-meter-text">
                <span>{quota.percentUsed.toFixed(1)}% used</span>
                <span>{quota.fileCount + quota.recordCount} items</span>
              </div>
            </div>
          )}
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
                <strong>
                  {quota ? formatBytes(quota.usedBytes) : '0 B'} of 1 TB used
                </strong>
                <span>
                  {quota
                    ? formatBytes(quota.remainingBytes) + ' still available'
                    : 'Quota enforced per account'}
                </span>
              </div>
              <ShieldCheck size={18} className="plan-shield" />
            </div>
          </div>

          {quota && (
            <div className="vault-capacity">
              <div className="capacity-head">
                <div>
                  <span className="eyebrow">VAULT CAPACITY</span>
                  <strong>
                    {formatBytes(quota.usedBytes + quota.reservedBytes)} / 1 TB
                  </strong>
                </div>
                <div className="capacity-actions">
                  <button
                    className="ghost-button"
                    onClick={() => void runMaintenance('sweep')}
                    disabled={maintenanceBusy !== ''}
                    title="Release space held by abandoned uploads"
                  >
                    {maintenanceBusy === 'sweep' ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Zap size={14} />
                    )}
                    Reclaim space
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => void runMaintenance('reconcile')}
                    disabled={maintenanceBusy !== ''}
                    title="Recompute usage from stored parts"
                  >
                    {maintenanceBusy === 'reconcile' ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    Verify usage
                  </button>
                </div>
              </div>
              <div className="capacity-track">
                <span
                  className="capacity-used"
                  style={{
                    width:
                      Math.max(
                        0.4,
                        (quota.usedBytes / quota.quotaBytes) * 100
                      ) + '%',
                  }}
                />
                {quota.reservedBytes > 0 && (
                  <span
                    className="capacity-reserved"
                    style={{
                      left: (quota.usedBytes / quota.quotaBytes) * 100 + '%',
                      width: Math.min(
                        100,
                        (quota.reservedBytes / quota.quotaBytes) * 100
                      ) + '%',
                    }}
                  />
                )}
              </div>
              <div className="capacity-legend">
                <span>
                  <i className="dot used" /> {formatBytes(quota.usedBytes)} saved
                </span>
                {quota.reservedBytes > 0 && (
                  <span>
                    <i className="dot reserved" />{' '}
                    {formatBytes(quota.reservedBytes)} in flight
                  </span>
                )}
                <span>
                  <i className="dot free" /> {formatBytes(quota.remainingBytes)}{' '}
                  free
                </span>
                <span className="capacity-limits">
                  Max file {formatBytes(limits?.maxFileSize ?? quota.quotaBytes)} ·
                  parts {formatBytes(limits?.chunkSize ?? 1048576)}
                </span>
              </div>
            </div>
          )}

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

            {jobs.length > 0 && (
              <div className="transfer-panel">
                <div className="transfer-head">
                  <strong>
                    <ArrowUpFromLine size={15} /> Transfers
                  </strong>
                  <button
                    className="ghost-button"
                    onClick={() => setJobs([])}
                    disabled={uploading}
                  >
                    Clear finished
                  </button>
                </div>
                <ul className="transfer-list">
                  {jobs.slice(0, 6).map(job => (
                    <li key={job.key} className={'transfer-row ' + job.status}>
                      <div className="transfer-copy">
                        <strong>{job.name}</strong>
                        <span>
                          {formatBytes(job.size)}
                          {job.progress &&
                            ' · ' +
                              formatBytes(Math.round(job.progress.bytesPerSecond)) +
                              '/s · ' +
                              formatDuration(job.progress.etaSeconds) +
                              ' left'}
                          {job.status === 'done' && ' · Saved'}
                          {job.status === 'cancelled' && ' · Paused'}
                          {job.status === 'failed' && ' · ' + (job.message || 'Failed')}
                        </span>
                        <div className="progress-track">
                          <span
                            style={{
                              width:
                                (job.status === 'done'
                                  ? 100
                                  : job.progress?.percent || 0) + '%',
                            }}
                          />
                        </div>
                      </div>
                      <div className="transfer-actions">
                        {job.status === 'active' && (
                          <>
                            <span className="progress-percent">
                              {job.progress?.percent || 0}%
                            </span>
                            {activeJob === job.key && (
                              <button
                                className="icon-button"
                                onClick={pauseUpload}
                                title="Pause upload"
                                aria-label="Pause upload"
                              >
                                <Pause size={15} />
                              </button>
                            )}
                          </>
                        )}
                        {(job.status === 'cancelled' || job.status === 'failed') && (
                          <button
                            className="ghost-button"
                            onClick={() => void resumeJob(job)}
                          >
                            Resume
                          </button>
                        )}
                        {job.status === 'done' && (
                          <span className="transfer-done">
                            <Check size={14} />
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {downloadState && (
              <div className="progress-panel download-panel">
                <div className="progress-icon">
                  <Download size={17} />
                </div>
                <div className="progress-copy">
                  <strong>Downloading file</strong>
                  <span>
                    {downloadState.progress
                      ? downloadState.progress.percent +
                        '% · ' +
                        formatBytes(downloadState.progress.bytesDone) +
                        ' of ' +
                        formatBytes(downloadState.progress.bytesTotal)
                      : 'Reading file parts…'}
                  </span>
                  <div className="progress-track">
                    <span
                      style={{
                        width: (downloadState.progress?.percent || 0) + '%',
                      }}
                    />
                  </div>
                </div>
                <button className="ghost-button" onClick={cancelDownload}>
                  Cancel
                </button>
              </div>
            )}
            {exporting && (
              <div className="progress-panel export-progress">
                <div className="progress-icon">
                  <Archive size={17} />
                </div>
                <div className="progress-copy">
                  <strong>Building your backup</strong>
                  <span>{exportLabel || 'Collecting records and file contents'}</span>
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
                  <>
                    <button
                      className="primary-button"
                      onClick={() => void downloadItem(selected)}
                      disabled={downloadState !== null}
                    >
                      {downloadState?.id === selected.id ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Download size={16} />
                      )}
                      {downloadState?.id === selected.id
                        ? 'Downloading ' +
                          (downloadState.progress?.percent || 0) +
                          '%'
                        : 'Download original file'}
                    </button>
                    {(selected.size || 0) > BLOB_DOWNLOAD_SAFE_LIMIT && (
                      <p className="hint-text">
                        Large file: this browser will save it in chunks straight
                        to disk where supported, otherwise it must be held in
                        memory.
                      </p>
                    )}
                  </>
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

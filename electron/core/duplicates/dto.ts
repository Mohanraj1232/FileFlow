import type {
  DuplicateFile,
  DuplicateGroup,
  DuplicateScanSummary,
  DuplicateScanStats,
} from '../../shared/contract';
import type { ScanEntry } from './store';
import type { DupFile, DupGroup, ScanStats } from './scan';

const MAX_ERRORS_SENT = 100;

export function toFileDto(file: DupFile, copyId: number): DuplicateFile {
  return {
    path: file.path,
    name: file.name,
    size: file.size,
    modified_at: new Date(file.mtimeMs).toISOString(),
    hash_status: file.hashSource === 'cached' ? 'cached' : 'verified',
    copy_id: copyId,
  };
}

export function toGroupDto(group: DupGroup): DuplicateGroup {
  // Number the distinct stored copies in file order so the UI can label hard links.
  const ids = new Map<string, number>();
  for (const f of group.files) {
    if (!ids.has(f.linkKey)) ids.set(f.linkKey, ids.size + 1);
  }
  return {
    hash: group.hash,
    size: group.size,
    file_count: group.files.length,
    copies: ids.size,
    total_size: group.size * ids.size,
    reclaimable_bytes: group.reclaimableBytes,
    files: group.files.map((f) => toFileDto(f, ids.get(f.linkKey)!)),
  };
}

function toStatsDto(stats: ScanStats): DuplicateScanStats {
  return {
    files_scanned: stats.filesScanned,
    bytes_scanned: stats.bytesScanned,
    candidate_files: stats.candidateFiles,
    files_hashed: stats.filesHashed,
    files_from_cache: stats.filesFromCache,
    bytes_hashed: stats.bytesHashed,
    group_count: stats.groups,
    duplicate_files: stats.duplicateFiles,
    reclaimable_bytes: stats.reclaimableBytes,
    errors: stats.errors.slice(0, MAX_ERRORS_SENT),
    error_count: stats.errors.length,
  };
}

export function toSummaryDto(entry: ScanEntry): DuplicateScanSummary {
  const p = entry.progress;
  return {
    scan_id: entry.id,
    state: entry.state,
    roots: entry.roots,
    progress: p
      ? {
          phase: p.phase,
          files_seen: p.filesSeen,
          bytes_seen: p.bytesSeen,
          candidate_files: p.candidateFiles,
          hashed_files: p.hashedFiles,
          hashed_bytes: p.hashedBytes,
          total_hash_bytes: p.totalHashBytes,
          current_path: p.currentPath,
        }
      : null,
    stats: entry.result ? toStatsDto(entry.result.stats) : null,
    error: entry.error,
  };
}

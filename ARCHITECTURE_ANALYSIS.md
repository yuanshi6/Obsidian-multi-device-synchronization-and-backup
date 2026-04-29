# S3 Manifest-Sync 深度架构分析与优化方案

---

## 1. 当前架构总结

### 1.1 scanner.ts — 核心数据结构与 Diff 算法

**数据模型（V4 版本链）：**
- `FileState`：`fileId / version / baseVersion / contentHash / mtime / lastModifiedBy / remoteRevision / parentHash`
- `DeletedEntry`：`mtime / deletedBy / version / baseVersion / fileId / contentHash / remoteRevision / ackedBy`
- `SyncManifest`：`version / deviceId / deviceName / lastSyncTime / files / deleted / remoteRevision`

**关键函数：**
- `sha256Hex()` — Web Crypto SHA-256，内容寻址基础
- `isLocalDirty(state)` — `contentHash !== parentHash`（内容哈希偏离父版本哈希）
- `normalizeFileState()` — V3→V4 迁移，补齐缺失字段
- `mergeDiskWithLedger()` — 磁盘真实内容哈希 + 账本版本元数据合并
- `computeSyncDelta()` — 版本链 Diff 算法，输出 upload/download/delete/localDelete/conflict/hashStitched 六队列
- `FileScanner.scanAll()` — 递归遍历 vault，计算每个文件的 SHA-256

**Diff 算法核心逻辑：**
1. 墓碑优先：local tomb + cloud tomb → skip；local tomb + cloud exists → baseVersion 匹配则 delete cloud，否则 conflict
2. 仅本地存在：dirty 或 version=0 → upload
3. 仅云端存在 → download
4. 双端存在：hash 相同 → stitch/skip；local dirty + baseVersion===cloud.version → upload；local dirty + baseVersion<cloud.version → conflict；local clean + cloud.version 更新 → download

### 1.2 transfer.ts — S3 传输管理器

- `S3TransferManager`：封装 S3Client，管理上传/下载/删除/manifest
- `uploadFile()` — 直接上传到真实路径（如 `notes/a.md`），附带 `x-amz-meta-content-sha256` 元数据
- `downloadAndWriteFile()` — 下载后计算 SHA-256 验证
- `fetchCloudManifest()` — 获取并迁移 V1/V2/V3 → V4
- `uploadManifest()` — **已实现 IfMatch/IfNoneMatch 条件写入**
- `cleanOrphanFiles()` — ListObjects 全桶扫描，删除不在 manifest 中的对象
- `processQueues()` — 并发池（MAX_CONCURRENCY=3），重试（MAX_RETRIES=3），本地删除收集 `localDeletedPaths`
- `fullSync()` — scanAll → merge → fetchCloudManifest → cleanOrphanFiles → computeSyncDelta → processQueues
- `quickSync()` — **仍然 scanAll()**，未实现 pending-only

### 1.3 main.ts — Obsidian 事件监听与同步调度

**事件拦截：**
- `onFileModify` — `isSyncing` 守卫 → 更新 ledger（baseVersion=existing.version, parentHash=existing.contentHash）
- `onFileCreate` — `isSyncing` 守卫 → 委托 onFileModify
- `onFileDelete` — `isSyncing` 守卫 → 仅处理 .md 文件 → createDeletedEntry + 删除 ledger
- `onFileRename` — 转移 ledger + 为旧路径 createDeletedEntry

**防抖与持久化：**
- `triggerDebouncedSync()` — 3秒防抖，**先 persist 再 sync**
- `persistLedger()` / `persistTombstones()` — localStorage 持久化
- 墓碑 GC：**已移除 30 天过期清理**，改为长期保留

**同步入口：**
- `startSync()` — `_syncing` + `isSyncing` 双锁，fullSync 后回写 ledger
- manifest 条件写入失败时，**保留本地账本原状**，等待下次重试

### 1.4 ConflictModal.ts — 冲突处理

- UI 弹窗：显示本地/云端设备名和 mtime
- 三选一：以本地为准 / 以云端为准 / 保留双份副本
- **未被集成到同步主流程**：`computeSyncDelta` 输出 `conflictQueue` 但 `startSync` 只在 Notice 中提示数量，未调用 ConflictModal

### 1.5 settings.ts — 同步配置

- AK/SK/Endpoint/Region/Bucket — 认证与存储
- deviceId/deviceName — 设备身份
- autoSync/syncInterval — 定时同步（但 `setupAutoSync()` 是空实现）
- excludePatterns — 排除路径

---

## 2. 主要风险点

| # | 风险 | 严重性 | 说明 |
|---|------|--------|------|
| R1 | Android 后台丢 pending | **P0** | onFileModify 只更新内存 ledger，3 秒防抖后才 persist。Android 在防抖窗口内进后台，pending 丢失 |
| R2 | onFileDelete 仅处理 .md | **P0** | 图片/附件删除不生成墓碑，导致孤儿清理后又被下载回来（死循环） |
| R3 | quickSync 仍 scanAll | **P1** | Android 只改一个文件也要扫描整个 vault 计算 SHA-256，耗电+耗时 |
| R4 | cleanOrphanFiles 每次 fullSync 都执行 | **P1** | 每次同步都 ListObjects 全桶，Android 端产生多余请求 |
| R5 | 直接上传到真实路径 | **P1** | 两设备并发提交同一文件时，对象内容可能互相覆盖 |
| R6 | ConflictModal 未集成 | **P1** | 冲突文件只报数量，不弹窗也不生成冲突副本 |
| R7 | setupAutoSync 空实现 | **P2** | 定时同步未实现 |
| R8 | 无三方合并 | **P2** | Markdown 冲突只做 LWW 选择，不尝试 git-style merge |
| R9 | detectExternalModifications scanAll | **P1** | 启动时全量 SHA-256 扫描，大 vault 耗时 |

---

## 3. Android 同步问题的根因

**核心矛盾：Obsidian 插件无法可靠阻止 Android 杀后台。**

具体表现：
1. **防抖窗口丢数据**：用户修改文件 → onFileModify 更新内存 → 3 秒内 Android 杀后台 → ledger 和 tombstone 未持久化 → 下次启动不知道有修改
2. **同步中途被杀**：startSync 正在执行 → 下载了 3 个文件但 manifest 还没上传 → Android 杀后台 → 下次启动可能重复下载或状态不一致
3. **全量扫描耗时**：scanAll 对 1000+ 文件的 vault 计算全量 SHA-256 → Android 弱网+慢 CPU → 用户等不及就切走 → 又被杀
4. **删除附件不立碑**：用户删除图片 → onFileDelete 只处理 .md → 图片无墓碑 → 同步引擎从云端重新下载 → 死循环

---

## 4. "哪个文件最新"的正确判断规则

当前 V4 版本链模型**基本正确**，但有几个残留问题：

### 4.1 正确的部分

- `isLocalDirty(state) = contentHash !== parentHash` — 正确，基于内容哈希偏离
- `local dirty + baseVersion === cloud.version → upload` — 正确，fast-path 提交
- `local dirty + baseVersion < cloud.version → conflict` — 正确，检测并发修改
- `local clean + cloud.version > local.version → download` — 正确

### 4.2 仍然依赖 mtime 的地方

1. **`FileState.mtime`** — 声明"仅作显示/元数据"，但 `createLocalFileState` 用 `stat.mtime` 填充，`mergeDiskWithLedger` 在内容变化时用 `diskEntry.mtime` 更新。**只要不参与新旧判定就不算 bug**，但容易在未来代码中被误用。
2. **`ConflictModal`** — 用 `localMtime` / `cloudMtime` 展示给用户，这是合理的（仅展示）。
3. **`DeletedEntry.mtime`** — 墓碑时间戳，不参与判定，仅用于 GC。

### 4.3 local dirty 的正确定义

当前定义 `contentHash !== parentHash` 是正确的。等价语义：**本地内容相对于最后确认的云端版本发生了变化**。

注意：`version === 0` 也应视为 dirty（新文件从未同步），当前代码在 `local && !cloud` 分支已处理 `version === 0`。

### 4.4 判定规则总结

| 场景 | 判定 | 动作 |
|------|------|------|
| 仅本地，dirty 或 version=0 | 本地更新 | upload |
| 仅本地，clean 且 version>0 | 已同步但云端丢失 | upload（保守） |
| 仅云端 | 云端更新 | download |
| 双端 hash 相同 | 一致 | stitch/skip |
| 本地 dirty，baseVersion=cloud.version | 本地更新 | upload（fast-path） |
| 本地 dirty，baseVersion<cloud.version | 并发修改 | conflict |
| 本地 clean，cloud.version>local.version | 云端更新 | download |
| 本地 clean，cloud.version<=local.version | 异常 | conflict |
| 本地 tomb，cloud.version=tomb.baseVersion | 本地删除 | delete cloud |
| 本地 tomb，cloud.version>tomb.baseVersion | 删除-修改冲突 | conflict |
| cloud tomb，本地 clean，local.version<=tomb.version | 云端删除 | delete local |
| cloud tomb，本地 dirty | 修改-删除冲突 | conflict |

---

## 5. P0 修改方案

### 5.1 PendingState 数据结构

```typescript
interface PendingEvent {
  type: "modify" | "create" | "delete" | "rename";
  path: string;
  oldPath?: string;          // 仅 rename
  timestamp: number;         // Date.now()
  baseVersion: number;       // 事件发生时的云端版本
  parentHash: string;        // 事件发生时的内容哈希
  fileId: string;
}
```

### 5.2 Pending 持久化方式

使用 `app.saveLocalStorage("s3-sync-pending", JSON.stringify(pendingEvents))`。
每次 onFileModify/onFileDelete/onFileRename **立即** 追加并持久化，不等防抖。

```typescript
private pendingEvents: PendingEvent[] = [];

private pushPending(event: PendingEvent): void {
  this.pendingEvents.push(event);
  this.app.saveLocalStorage("s3-sync-pending", JSON.stringify(this.pendingEvents));
}
```

### 5.3 onFileModify 改造

```typescript
private onFileModify(file: TAbstractFile): void {
  if (this.isSyncing) return;
  if (!(file instanceof TFile)) return;
  if (this.isPathExcluded(file.path)) return;

  const existing = this.localLedger[file.path]
    ? normalizeFileState(file.path, this.localLedger[file.path], this.settings.deviceId)
    : undefined;
  const tomb = this.localTombstones[file.path]
    ? normalizeDeletedEntry(file.path, this.localTombstones[file.path], this.settings.deviceId)
    : undefined;

  const baseVersion = existing?.version ?? tomb?.version ?? 0;
  const parentHash = existing?.contentHash ?? tomb?.contentHash ?? "";

  // 立即更新内存 ledger
  this.localLedger[file.path] = {
    fileId: existing?.fileId ?? tomb?.fileId ?? file.path,
    version: existing?.version ?? tomb?.version ?? 0,
    baseVersion,
    contentHash: "",  // 稍后由扫描器补齐
    mtime: Date.now(),
    lastModifiedBy: this.settings.deviceId,
    remoteRevision: existing?.remoteRevision ?? tomb?.remoteRevision,
    parentHash,
  };
  if (this.localTombstones[file.path]) {
    delete this.localTombstones[file.path];
  }

  // ★ 立即持久化 ledger + pending
  this.persistLedger();
  this.persistTombstones();
  this.pushPending({
    type: existing ? "modify" : "create",
    path: file.path,
    timestamp: Date.now(),
    baseVersion,
    parentHash,
    fileId: existing?.fileId ?? tomb?.fileId ?? file.path,
  });

  this.triggerDebouncedSync();
}
```

### 5.4 onFileDelete 改造 — 处理所有文件类型

```typescript
private onFileDeleteByPath(path: string): void {
  if (this.isPathExcluded(path)) return;
  // ★ 移除 .md 限制，所有文件类型都立碑

  const oldEntry = this.localLedger[path]
    ? normalizeFileState(path, this.localLedger[path], this.settings.deviceId)
    : undefined;
  const baseVersion = oldEntry?.version ?? 0;

  this.localTombstones[path] = createDeletedEntry(
    path, this.settings.deviceId, baseVersion,
    oldEntry?.fileId ?? path, oldEntry?.contentHash ?? "", oldEntry?.remoteRevision,
  );
  delete this.localLedger[path];

  // ★ 立即持久化
  this.persistLedger();
  this.persistTombstones();
  this.pushPending({
    type: "delete",
    path,
    timestamp: Date.now(),
    baseVersion,
    parentHash: oldEntry?.contentHash ?? "",
    fileId: oldEntry?.fileId ?? path,
  });
}
```

### 5.5 onFileRename 改造

```typescript
private onFileRename(file: TAbstractFile, oldPath: string): void {
  if (!(file instanceof TFile)) return;
  const newPath = file.path;

  const oldEntry = this.localLedger[oldPath]
    ? normalizeFileState(oldPath, this.localLedger[oldPath], this.settings.deviceId)
    : undefined;

  if (oldEntry) {
    this.localLedger[newPath] = {
      ...oldEntry,
      fileId: oldEntry.fileId || oldPath,
      parentHash: "",  // 标记 dirty
      mtime: Date.now(),
      lastModifiedBy: this.settings.deviceId,
    };
    delete this.localLedger[oldPath];
    this.localTombstones[oldPath] = createDeletedEntry(
      oldPath, this.settings.deviceId, oldEntry.version,
      oldEntry.fileId, oldEntry.contentHash, oldEntry.remoteRevision,
    );
  } else {
    this.localLedger[newPath] = {
      fileId: newPath, version: 0, baseVersion: 0,
      contentHash: "", mtime: Date.now(),
      lastModifiedBy: this.settings.deviceId, parentHash: "",
    };
  }

  // ★ 立即持久化
  this.persistLedger();
  this.persistTombstones();
  this.pushPending({
    type: "rename", path: newPath, oldPath,
    timestamp: Date.now(),
    baseVersion: oldEntry?.version ?? 0,
    parentHash: oldEntry?.contentHash ?? "",
    fileId: oldEntry?.fileId ?? oldPath,
  });

  this.triggerDebouncedSync();
}
```

### 5.6 triggerDebouncedSync 改造

防抖**只延迟网络同步**，不延迟本地持久化（已在事件处理中立即 persist）：

```typescript
private triggerDebouncedSync(): void {
  const {accessKey, secretKey, endpoint, bucketName} = this.settings;
  if (!accessKey || !secretKey || !endpoint || !bucketName) return;

  if (this.syncTimeout !== null) {
    window.clearTimeout(this.syncTimeout);
  }

  this.syncTimeout = window.setTimeout(() => {
    this.syncTimeout = null;
    // 本地状态已持久化，直接执行网络同步
    this.startSync(true);
  }, DEBOUNCE_MS);
}
```

### 5.7 Android 后台 flush

```typescript
async onload() {
  // ... 现有初始化 ...

  // ★ 监听页面可见性变化，尽力 flush
  this.registerEvent(this.app.vault.on("modify", () => {})); // 保持现有
  const flushOnHide = () => {
    if (document.visibilityState === "hidden" && this.pendingEvents.length > 0) {
      console.log("[S3 Sync] 页面隐藏，尽力 flush pending");
      this.flushPendingFast(3000); // 3 秒预算
    }
  };
  document.addEventListener("visibilitychange", flushOnHide);
  this.register(() => document.removeEventListener("visibilitychange", flushOnHide));

  // ★ pagehide 作为后备
  const flushOnPageHide = () => {
    this.persistLedger();
    this.persistTombstones();
    this.persistPending();
  };
  window.addEventListener("pagehide", flushOnPageHide);
  this.register(() => window.removeEventListener("pagehide", flushOnPageHide));
}

private async flushPendingFast(timeBudgetMs: number): Promise<void> {
  if (this._syncing) return;
  const deadline = Date.now() + timeBudgetMs;

  // 至少确保本地状态已持久化
  this.persistLedger();
  this.persistTombstones();
  this.persistPending();

  // 如果时间允许，尝试一次快速同步
  if (Date.now() < deadline - 1000) {
    try {
      await this.startSync(true);
    } catch {
      // flush 失败不报错，下次启动会恢复
    }
  }
}
```

### 5.8 启动时恢复 pending

```typescript
async onload() {
  // ... 现有初始化 ...

  // ★ 恢复未完成的 pending
  this.pendingEvents = this.loadPending();
  if (this.pendingEvents.length > 0) {
    console.log("[S3 Sync] 恢复", this.pendingEvents.length, "个未完成 pending 事件");
    // pending 已在 ledger/tombstone 中体现，只需触发同步
    this.triggerDebouncedSync();
  }
}

private loadPending(): PendingEvent[] {
  const raw = this.app.loadLocalStorage("s3-sync-pending");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

private persistPending(): void {
  this.app.saveLocalStorage("s3-sync-pending", JSON.stringify(this.pendingEvents));
}

// 同步成功后清除 pending
private clearPendingForPaths(paths: string[]): void {
  const pathSet = new Set(paths);
  this.pendingEvents = this.pendingEvents.filter(e => !pathSet.has(e.path));
  this.persistPending();
}
```

---

## 6. P1 修改方案

### 6.1 quickSync 改为 pending-only

```typescript
async quickSync(
  deviceId: string,
  localLastSyncTime: number,
  pendingPaths: string[],     // ★ 新增：只处理这些路径
  localTombstones: Record<string, DeletedEntry> = {},
  localLedger: Record<string, FileState> = {},
): Promise<SyncResult> {
  if (this.isSyncing) { /* ... */ }
  this.isSyncing = true;
  try {
    // ★ 只扫描 pending 路径，不全量扫描
    const diskFiles = await this.scanner.scanPaths(pendingPaths);

    const localFiles: Record<string, FileState> = {};
    for (const path of pendingPaths) {
      const diskEntry = diskFiles[path];
      const ledgerEntry = localLedger[path];
      if (diskEntry) {
        localFiles[path] = mergeDiskWithLedger(path, diskEntry, ledgerEntry, deviceId);
      }
      // 磁盘不存在的路径（已删除）不加入 localFiles
    }

    this.localManifest = {...localFiles};
    const cloudManifest = await this.fetchCloudManifest();
    const delta = computeSyncDelta(localFiles, cloudManifest, deviceId, localTombstones, localLedger);

    // ... 后续与 fullSync 相同 ...
  } finally {
    this.isSyncing = false;
  }
}
```

### 6.2 FileScanner.scanPaths()

```typescript
async scanPaths(paths: string[]): Promise<Record<string, FileState>> {
  const result: Record<string, FileState> = {};
  for (const path of paths) {
    if (this.isExcluded(path) || isSystemFile(path)) continue;
    try {
      const stat = await this.adapter.stat(path);
      if (stat && stat.mtime != null) {
        const normalized = normalizeSyncPath(path);
        const bytes = new Uint8Array(await this.adapter.readBinary(path));
        const contentHash = await sha256Hex(bytes);
        result[normalized] = createLocalFileState(normalized, contentHash, stat.mtime, this.deviceId);
      }
    } catch {
      // 文件不存在或无法读取，跳过（已删除）
    }
  }
  return result;
}
```

### 6.3 cleanOrphanFiles 降频

```typescript
// 只在距上次清理超过 24 小时时执行
private lastOrphanCleanTime = 0;

async maybeCleanOrphans(cloudManifest: SyncManifest): Promise<number> {
  const now = Date.now();
  if (now - this.lastOrphanCleanTime < 24 * 60 * 60 * 1000) {
    console.log("[S3 Sync] 距上次孤儿清理不足 24 小时，跳过");
    return 0;
  }
  const count = await this.cleanOrphanFiles(cloudManifest);
  this.lastOrphanCleanTime = now;
  return count;
}
```

### 6.4 同步锁一致性修复

当前 `_syncing` 和 `isSyncing` 已在 `startSync` 中同步设置，但 `isSyncing` 应在 `fullSync`/`quickSync` 入口就设置，确保 Observer 在整个同步期间静默：

```typescript
// startSync 中：
this._syncing = true;
this.isSyncing = true;  // ★ 确保同步设置

// finally 中：
this._syncing = false;
this.isSyncing = false;  // ★ 确保同步清除
```

### 6.5 Path-level 回声抑制

除了全局 `isSyncing` 锁，增加 `applyingRemotePaths` 集合，更精确地抑制：

```typescript
public applyingRemotePaths: Set<string> = new Set();

// downloadAndWriteFile 中：
this.applyingRemotePaths.add(path);
try {
  await this.vault.adapter.write(path, text);
} finally {
  this.applyingRemotePaths.delete(path);
}

// onFileModify 中：
if (this.isSyncing || this.applyingRemotePaths.has(file.path)) return;
```

---

## 7. P2 修改方案

### 7.1 内容寻址对象布局

```
_objects/ab/abcdef0123456789...   (SHA-256 分片存储)
manifest.json                     (路径 → 版本链映射)
```

上传流程：
1. 计算本地文件 SHA-256 → `hash`
2. 上传到 `_objects/${hash.slice(0,2)}/${hash}`，使用 `IfNoneMatch: *` 避免重复上传
3. manifest 中 `path → {contentHash: hash, objectKey: "_objects/ab/abcdef...", version, ...}`

优点：
- 两设备并发提交同一文件：内容相同则 hash 相同，IfNoneMatch 静默成功；内容不同则 hash 不同，各自存不同对象
- 去重：相同内容只存一份
- 孤儿清理只需检查 `_objects/` 前缀

### 7.2 Manifest 并发提交重试

```typescript
async uploadManifestWithRetry(manifest: SyncManifest, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.uploadManifest(manifest);
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      // IfMatch 失败 → 重新拉取云端 manifest，合并本地变更
      const freshCloud = await this.fetchCloudManifest();
      manifest = this.mergeManifests(manifest, freshCloud);
    }
  }
}

private mergeManifests(local: SyncManifest, cloud: SyncManifest): SyncManifest {
  // 两设备修改不同文件 → 自动合并
  const mergedFiles = {...cloud.files};
  for (const [path, entry] of Object.entries(local.files)) {
    const cloudEntry = cloud.files[path];
    if (!cloudEntry) {
      mergedFiles[path] = entry;  // 仅本地有 → 保留
    } else if (entry.version > cloudEntry.version) {
      mergedFiles[path] = entry;  // 本地版本更高 → 保留
    }
    // cloud 版本更高或相同 → 保留 cloud
  }
  return {...local, files: mergedFiles, lastSyncTime: Date.now()};
}
```

### 7.3 三方合并（Markdown）

```typescript
async tryThreeWayMerge(
  baseContent: string,    // parentHash 对应的内容
  localContent: string,   // 本地当前内容
  remoteContent: string,  // 云端内容
): Promise<string | null> {
  // 使用 diff3 算法
  // 成功 → 返回合并后内容
  // 冲突 → 返回 null，由 ConflictModal 处理
  // 实现可使用 diff-match-patch 库或自定义行级 diff3
  return null; // 占位
}
```

### 7.4 冲突副本生成

```typescript
private async createConflictCopy(path: string, content: Uint8Array, suffix: string): Promise<string> {
  const dotIdx = path.lastIndexOf(".");
  const base = dotIdx === -1 ? path : path.slice(0, dotIdx);
  const ext = dotIdx === -1 ? "" : path.slice(dotIdx);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const conflictPath = `${base} ${suffix} ${timestamp}${ext}`;

  if (isBinaryPath(path)) {
    await this.vault.adapter.writeBinary(conflictPath, content.buffer);
  } else {
    const text = new TextDecoder().decode(content);
    await this.vault.adapter.write(conflictPath, text);
  }
  return conflictPath;
}
```

---

## 8. 关键 TypeScript 代码片段

### 8.1 PendingEvent 完整定义

```typescript
interface PendingEvent {
  type: "modify" | "create" | "delete" | "rename";
  path: string;
  oldPath?: string;
  timestamp: number;
  baseVersion: number;
  parentHash: string;
  fileId: string;
}
```

### 8.2 scanPaths 实现

```typescript
async scanPaths(paths: string[]): Promise<Record<string, FileState>> {
  const result: Record<string, FileState> = {};
  for (const path of paths) {
    if (this.isExcluded(path) || isSystemFile(path)) continue;
    try {
      const stat = await this.adapter.stat(path);
      if (stat && stat.mtime != null) {
        const normalized = normalizeSyncPath(path);
        const bytes = new Uint8Array(await this.adapter.readBinary(path));
        const contentHash = await sha256Hex(bytes);
        result[normalized] = createLocalFileState(normalized, contentHash, stat.mtime, this.deviceId);
      }
    } catch { /* 文件不存在，跳过 */ }
  }
  return result;
}
```

### 8.3 applyingRemotePaths 回声抑制

```typescript
// S3TransferManager 中
public applyingRemotePaths: Set<string> = new Set();

private async downloadAndWriteFile(path: string): Promise<{...}> {
  // ...
  this.applyingRemotePaths.add(path);
  try {
    if (isBinaryPath(path)) {
      await this.vault.adapter.writeBinary(path, buffer);
    } else {
      await this.vault.adapter.write(path, text);
    }
  } finally {
    this.applyingRemotePaths.delete(path);
  }
  // ...
}

// main.ts onFileModify 中
if (this.isSyncing || this.transferManager?.applyingRemotePaths?.has(file.path)) return;
```

---

## 9. 需要新增或修改的测试用例

### 9.1 Pending 立即持久化

```typescript
describe("Pending immediate persistence", () => {
  it("onFileModify persists ledger and pending immediately", () => {
    const plugin = new (S3SyncPlugin as any)();
    plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
    plugin.localLedger = {};
    plugin.pendingEvents = [];
    plugin.isSyncing = false;
    // mock persistLedger/persistTombstones/pushPending to track calls
    const persistCalls: string[] = [];
    plugin.persistLedger = () => persistCalls.push("ledger");
    plugin.persistTombstones = () => persistCalls.push("tombstones");
    plugin.pushPending = () => persistCalls.push("pending");

    plugin.onFileModify(new TFile("notes/a.md"));

    expect(persistCalls).toContain("ledger");
    expect(persistCalls).toContain("tombstones");
    expect(persistCalls).toContain("pending");
  });
});
```

### 9.2 删除所有文件类型都立碑

```typescript
describe("Delete all file types", () => {
  it("creates tombstone for .png file deletion", () => {
    const plugin = new (S3SyncPlugin as any)();
    plugin.settings = {deviceId: "dev1", excludePatterns: ""};
    plugin.localLedger = {"images/photo.png": fs(2, H1)};
    plugin.localTombstones = {};

    plugin.onFileDelete(new TFile("images/photo.png"));

    expect(plugin.localTombstones["images/photo.png"]).toBeDefined();
    expect(plugin.localLedger["images/photo.png"]).toBeUndefined();
  });
});
```

### 9.3 scanPaths 只扫描指定路径

```typescript
describe("FileScanner.scanPaths", () => {
  it("only scans specified paths", async () => {
    const adapter = mockAdapter({
      "a.md": {mtime: 1000, size: 10},
      "b.md": {mtime: 2000, size: 20},
    });
    const scanner = new FileScanner(adapter, defaultSettings);
    const result = await scanner.scanPaths(["a.md"]);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["a.md"]).toBeDefined();
  });
});
```

### 9.4 applyingRemotePaths 回声抑制

```typescript
describe("Echo suppression", () => {
  it("onFileModify skips when path is in applyingRemotePaths", () => {
    const plugin = new (S3SyncPlugin as any)();
    plugin.settings = {deviceId: "dev1", excludePatterns: ".obsidian,.trash"};
    plugin.localLedger = {"notes/a.md": fs(2, H1)};
    plugin.transferManager = {applyingRemotePaths: new Set(["notes/a.md"])};

    plugin.onFileModify(new TFile("notes/a.md"));
    // Should NOT update ledger
    expect(plugin.localLedger["notes/a.md"].contentHash).toBe(H1);
  });
});
```

### 9.5 Manifest 条件写入重试

```typescript
describe("Manifest conditional write retry", () => {
  it("retries on IfMatch failure with merged manifest", async () => {
    // Simulate IfMatch failure → re-fetch → merge → retry
    // ...
  });
});
```

---

## 10. 最终推荐的同步状态机

```
┌─────────┐  modify/create/delete/rename  ┌──────────┐
│  IDLE   │ ────────────────────────────── │  DIRTY   │
└─────────┘                               └──────────┘
     │                                          │
     │ startSync()                    immediate  │
     │                                persist +  │
     ▼                                pushPending│
┌──────────┐                              │     │
│ SCANNING │ ◄── debounce 3s ─────────────┘     │
└──────────┘                                    │
     │                                          │
     ▼                                          │
┌───────────┐                                   │
│ COMPUTING │ fetchCloudManifest + delta         │
└───────────┘                                   │
     │                                          │
     ▼                                          │
┌───────────┐                                   │
│ SYNCING   │ upload/download/delete             │
│ (locked)  │ isSyncing=true                     │
│           │ applyingRemotePaths tracking       │
└───────────┘                                   │
     │                                          │
     ▼                                          │
┌───────────┐                                   │
│ COMMITTING│ uploadManifest (IfMatch)           │
└───────────┘                                   │
     │ success    │ conflict                     │
     ▼            ▼                              │
┌──────────┐  ┌──────────┐                      │
│  DONE    │  │ CONFLICT │ ── ConflictModal ──┐ │
└──────────┘  └──────────┘                    │ │
     │              │                          │ │
     ▼              ▼                          ▼ ▼
  clearPending   user resolves           back to IDLE
  persistLedger  → upload/download
  back to IDLE   → back to COMMITTING
```

**关键不变量：**
1. **本地状态先于网络同步持久化** — 任何事件立即写 ledger/tombstone/pending
2. **isSyncing 锁 + applyingRemotePaths 集合** — 双重回声抑制
3. **所有文件类型删除都立碑** — 不限于 .md
4. **pending 在同步成功后清除** — 失败则保留，下次启动恢复
5. **manifest 条件写入 + 重试合并** — 两设备修改不同文件自动合并
6. **quickSync 只扫描 pending 路径** — 不 scanAll
7. **孤儿清理降频至 24h** — 不每次 fullSync 都 ListObjects

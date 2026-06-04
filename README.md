# S3 Manifest-Sync [v2.0.0]

Incremental vault sync across devices via S3-compatible object storage.

English | [中文文档](#中文文档)

---

## Features

- **Incremental Sync**: Based on version chain + SHA-256 content hashing, only uploads/downloads files with real changes
- **Multi-Device Coordination**: Each device has a unique deviceId; the cloud manifest records global file state; changes to different files on different devices merge automatically
- **Conflict Detection**: When two devices modify the same file simultaneously, conflicts are detected and the user is prompted to choose (local / cloud / both copies)
- **Tombstone Mechanism**: Deletions propagate to all devices via tombstones, preventing deleted files from being "resurrected" by other devices
- **Hash Stitching**: On cold start or device switch, files with identical SHA-256 content are stitched into the ledger without network transfer
- **Content-Addressed Storage**: Uploaded objects are stored at `{prefix}objects/{hash[0:2]}/{hash}`, automatically deduplicating identical content
- **Conditional Write**: manifest.json uses IfMatch/IfNoneMatch to prevent concurrent overwrites
- **Concurrent Transfer**: Upload/download/delete use a concurrency pool (max 3 on desktop, max 1 on mobile) with automatic retry (up to 3 attempts)
- **Echo Defense (Sync Lock)**: Path-level suppression with SHA-256 verification prevents the "download -> triggers modify -> re-upload" echo loop
- **Mobile Friendly**: Adapted for mobile Obsidian with weak-network support; event-driven debouncing instead of background timers

## How It Works

### Content-Addressed Storage

Files are stored by their SHA-256 hash rather than path. The S3 key format is:

```
{storagePrefix}objects/{hash[0:2]}/{sha256_hex}
```

This provides:
- **Automatic deduplication**: Identical content from different files/devices shares one S3 object
- **Idempotent uploads**: Re-uploading the same content is a no-op at the storage level
- **Tamper detection**: Hash is verified on both upload and download
- **S3 performance**: The two-character prefix distributes objects across partitions

The manifest records each file's `objectKey` pointing to the actual content-addressed object.

### Version Chain Decision Rules

| Scenario | Verdict | Action |
|----------|---------|--------|
| Local only, content changed | Local update | Upload |
| Cloud only | Cloud update | Download |
| Both sides, content hash identical | In sync | Skip |
| Local dirty, baseVersion = cloud.version | Local update | Upload (fast-path) |
| Local dirty, baseVersion < cloud.version | Concurrent edit | Conflict |
| Local clean, cloud.version newer | Cloud update | Download |
| Local deleted, cloud still exists | Local deletion | Delete from cloud |
| Cloud deleted, local still exists | Cloud deletion | Delete from local |

### Sync Architecture

```
Local Vault ──observer events──▶ Ledger (in-memory)
                                  │
                                  ▼ debounce 3s
                             startSync()
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
             scanAll()     fetchCloudManifest   computeSyncDelta
                  │               │               │
                  └───────────────┼───────────────┘
                                  ▼
                            processQueues()
                                  │
                  ┌───────┬───────┼───────┬───────┐
                  ▼       ▼       ▼       ▼       ▼
               upload  download  delete  localDel  conflict
                  │       │       │       │       │
                  └───────┴───────┼───────┴───────┘
                                  ▼
                         uploadManifest (IfMatch)
```

Observer events update the in-memory ledger. After a 3-second debounce, `startSync()` is triggered. The sync process has three phases: scan (`scanAll`), fetch cloud manifest and compute diff (`computeSyncDelta`), and execute queues (`processQueues`). The new manifest is committed to cloud via conditional write (`IfMatch`).

### Conflict Resolution

**Desktop**: A modal dialog appears with three options:
- "Use local version" — rebase local entry on top of cloud version
- "Use cloud version" — download cloud version to local
- "Keep both copies" — save cloud version as conflict copy (`{base}.conflict-{device}-{timestamp}{ext}`)

**Mobile**: Conflicts automatically resolve to "keep both copies" (no modal). If the user closes the modal without choosing, it defaults to "keep both" to prevent sync lock-up.

### Tombstone Mechanism

When a file is deleted, a `DeletedEntry` (tombstone) is created with `deletedBy`, `version`, and `baseVersion` fields. Tombstones propagate through the manifest to all devices, ensuring deleted files stay deleted.

- Local tombstones are persisted to `localStorage` (`s3-sync-tombstones`)
- Tombstone GC (`runTombstoneGC`) normalizes entries periodically
- Long-lived by design — prevents file resurrection from long-offline devices

### Hash Stitching

On cold start or device switch, the plugin scans local files and computes SHA-256 hashes. If a local file and cloud file have identical content but no matching ledger entry, the file is "stitched" directly into the local ledger without any network transfer.

This also detects external modifications made while Obsidian was closed (`detectExternalModifications`).

### Echo Defense

During sync writes, the plugin uses path-level suppression to prevent echo loops:

1. Before writing a file: `beginSuppressPath(path)`
2. After writing: `endSuppressPath(path, contentHash)` sets expected hash and starts 1500ms timer
3. When Obsidian fires a modify event for a suppressed path, `isSyncWriteEcho()` compares disk hash with expected hash
4. If hashes match → sync echo, event is ignored
5. If hashes differ → real user edit, event is recorded as pending

This replaces the earlier global `isSyncing` flag that would swallow all events including genuine user edits.

## Supported Providers

- AWS S3
- Tencent COS
- Cloudflare R2
- MinIO (enable Force Path Style)
- Any S3-compatible object storage

## Installation

### Option 1: Obsidian Community Plugin (Recommended)

1. Open Obsidian Settings → Third-party plugins → Browse
2. Search for "S3 Manifest-Sync"
3. Install and enable the plugin

### Option 2: Manual Installation

1. Download `main.js`, `manifest.json`, `styles.css` from [Releases](https://github.com/yuanshi/obsidian-s3-manifest-sync/releases)
2. Copy to your Vault's `.obsidian/plugins/s3-manifest-sync/` directory
3. Enable the plugin in Obsidian settings

### Option 3: Build from Source

```bash
git clone https://github.com/yuanshi/obsidian-s3-manifest-sync.git
cd obsidian-s3-manifest-sync
npm i
npm run build
```

Then copy `main.js`, `manifest.json`, `styles.css` to your Vault's `.obsidian/plugins/s3-manifest-sync/` directory.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Access Key / Secret Key | S3-compatible storage access credentials | - |
| Endpoint | Storage service endpoint (e.g., `https://cos.ap-beijing.myqcloud.com`) | - |
| Region | Storage bucket region | us-east-1 |
| Bucket Name | Storage bucket name | - |
| Storage Prefix | S3 prefix path for sync objects | `_obsidian-sync/` |
| Force Path Style | Enable for MinIO and similar services | Off |
| Device Name | Identifies this device (e.g., "Work Laptop", "Phone") | 未命名设备 |
| Device ID | Auto-generated unique identifier (8 chars) | Auto-generated |
| Auto Sync | Enable periodic automatic sync | Off |
| Sync Interval | Automatic sync interval (minutes) | 30 |
| Exclude Patterns | Path patterns to skip (comma-separated globs) | `.obsidian,.trash` |
| Conditional Write | Use ETag to prevent concurrent overwrites | On |
| Orphan Cleanup | Clean up unreferenced cloud objects | Off |

## Development

```bash
npm i          # Install dependencies
npm run dev    # Development mode (esbuild watch)
npm run build  # Production build (TypeScript check + esbuild minify)
npx jest       # Run tests
npm run lint   # ESLint check
```

## Project Structure

```
src/
  main.ts           # Plugin entry, observer events, sync orchestration, status bar
  scanner.ts        # File scanner, version chain model, SHA-256 hashing, diff algorithm
  transfer.ts       # S3 transfer manager, concurrency pool, content-addressed storage
  settings.ts       # Plugin settings UI and defaults
  ConflictModal.ts  # Conflict resolution modal dialog
tests/
  __mocks__/obsidian.ts  # Obsidian API mock
  scanner.test.ts        # Scanner and diff algorithm tests
  main.test.ts           # Plugin behavior tests
  transfer.test.ts       # Transfer manager tests
```

## Tech Stack

| Category | Technology |
|----------|------------|
| Language | TypeScript (strict, ES2018) |
| Platform | Obsidian Plugin API |
| Bundler | esbuild (CJS) |
| S3 Client | @aws-sdk/client-s3 v3 |
| Testing | Jest 30 + ts-jest |
| Linting | ESLint 9 + typescript-eslint |

## License

[0BSD](LICENSE)

---

# 中文文档

通过 S3 兼容对象存储在多个设备之间增量同步你的 Obsidian Vault。

## 核心特性

- **增量同步**：基于版本链 + SHA-256 内容哈希，只上传/下载真正变化的文件
- **多设备协同**：每台设备拥有独立 deviceId，云端 manifest 记录全局文件状态，不同设备修改不同文件时自动合并
- **冲突检测**：当两台设备同时修改同一文件时，自动检测冲突并提示用户选择（本地/云端/双份副本）
- **墓碑机制**：删除操作通过 tombstone 传播到所有设备，防止已删除文件被其他设备"复活"
- **哈希缝合**：冷启动或换设备时，相同 SHA-256 内容的文件直接编入账本，无需网络传输
- **内容寻址存储**：上传对象存储在 `{prefix}objects/{hash[0:2]}/{hash}`，自动去重
- **条件写入**：manifest.json 使用 IfMatch/IfNoneMatch 条件写入，防止并发覆盖
- **并发传输**：上传/下载/删除使用并发池（桌面端最多 3，移动端 1），带自动重试（最多 3 次）
- **回声防御（同步锁）**：路径级抑制 + SHA-256 验证，防止"下载→触发修改→重新上传"的回声循环
- **移动端友好**：适配移动端 Obsidian，支持弱网环境，通过文件事件防抖同步而非后台定时器

## 工作原理

### 内容寻址存储

文件以 SHA-256 哈希值作为存储路径，而非文件路径。S3 对象 key 格式为：

```
{storagePrefix}objects/{hash[0:2]}/{sha256_hex}
```

优势：
- **自动去重**：不同文件/设备的相同内容共享一个 S3 对象
- **幂等上传**：重复上传相同内容在存储层是无操作
- **防篡改检测**：上传和下载时都会验证哈希
- **S3 性能**：两字符前缀将对象分布到不同分区

manifest 中每条文件记录通过 `objectKey` 字段指向实际的内容寻址对象。

### 版本链判定规则

| 场景 | 判定 | 动作 |
|------|------|------|
| 仅本地存在，内容有变化 | 本地更新 | 上传 |
| 仅云端存在 | 云端更新 | 下载 |
| 双端内容哈希相同 | 一致 | 跳过 |
| 本地有修改，baseVersion = cloud.version | 本地更新 | 上传（fast-path） |
| 本地有修改，baseVersion < cloud.version | 并发修改 | 冲突 |
| 本地无修改，cloud.version 更新 | 云端更新 | 下载 |
| 本地已删除，cloud 仍存在 | 本地删除 | 删除云端 |
| 云端已删除，本地仍存在 | 云端删除 | 删除本地 |

### 同步架构

```
本地 Vault ──观察者事件──▶ Ledger（内存账本）
                              │
                              ▼ 防抖 3s
                         startSync()
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         scanAll()     fetchCloudManifest   computeSyncDelta
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                        processQueues()
                              │
              ┌───────┬───────┼───────┬───────┐
              ▼       ▼       ▼       ▼       ▼
           upload  download  delete  localDel  conflict
              │       │       │       │       │
              └───────┴───────┼───────┴───────┘
                              ▼
                     uploadManifest (IfMatch)
```

观察者事件在内存中更新账本（ledger），3 秒防抖后触发 `startSync()`。同步过程分为三个阶段：扫描（scanAll）、获取云端 manifest 并计算 diff（computeSyncDelta）、执行队列（processQueues）。最终通过 IfMatch 条件写入将新 manifest 提交到云端。

### 冲突解决

**桌面端**：弹出模态框，提供三个选项：
- "以本地为准" — 将本地条目 rebase 到云端版本之上
- "以云端为准" — 下载云端版本到本地
- "保留双份副本" — 将云端版本保存为冲突副本（`{base}.conflict-{device}-{timestamp}.{ext}`）

**移动端**：冲突自动选择"保留双份副本"（无模态框）。如果用户关闭模态框未做选择，默认选择"保留双份"以防止同步锁死。

### 墓碑机制

删除文件时，会创建 `DeletedEntry`（墓碑），记录 `deletedBy`、`version`、`baseVersion` 字段。墓碑通过 manifest 在设备间传播，确保已删除的文件保持删除状态。

- 本地墓碑持久化到 `localStorage`（`s3-sync-tombstones`）
- 墓碑 GC（`runTombstoneGC`）定期规范化条目
- 设计上长期保留 — 防止长期离线设备复活文件

### 哈希缝合

冷启动或换设备时，插件扫描本地文件并计算 SHA-256 哈希。如果本地文件和云端文件内容相同但无匹配的账本条目，文件会直接"缝合"到本地账本，无需任何网络传输。

这也会检测 Obsidian 关闭期间的外部修改（`detectExternalModifications`）。

### 回声防御

同步写入期间，插件使用路径级抑制来防止回声循环：

1. 写入文件前：`beginSuppressPath(path)`
2. 写入后：`endSuppressPath(path, contentHash)` 设置预期哈希并启动 1500ms 计时器
3. 当 Obsidian 对被抑制路径触发 modify 事件时，`isSyncWriteEcho()` 比较磁盘哈希与预期哈希
4. 哈希匹配 → 同步回声，事件被忽略
5. 哈希不同 → 真实用户编辑，事件被记录为 pending

这替代了早期的全局 `isSyncing` 标志，该标志会吞掉所有事件包括真实的用户编辑。

## 支持的存储服务

- AWS S3
- 腾讯云 COS
- Cloudflare R2
- MinIO（需开启 Force Path Style）
- 任何 S3 兼容对象存储

## 安装

### 方式一：Obsidian 社区插件市场（推荐）

1. 打开 Obsidian 设置 → 第三方插件 → 浏览
2. 搜索 "S3 Manifest-Sync"
3. 安装并启用插件

### 方式二：手动安装

1. 从 [Releases](https://github.com/yuanshi/obsidian-s3-manifest-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 复制到 Vault 的 `.obsidian/plugins/s3-manifest-sync/` 目录
3. 在 Obsidian 设置中启用插件

### 方式三：从源码构建

```bash
git clone https://github.com/yuanshi/obsidian-s3-manifest-sync.git
cd obsidian-s3-manifest-sync
npm i
npm run build
```

然后将 `main.js`、`manifest.json`、`styles.css` 复制到 Vault 的 `.obsidian/plugins/s3-manifest-sync/` 目录。

## 配置项

| 配置 | 说明 | 默认值 |
|------|------|--------|
| Access Key / Secret Key | S3 兼容存储的访问密钥 | - |
| Endpoint | 存储服务端点（如 `https://cos.ap-beijing.myqcloud.com`） | - |
| Region | 存储桶所在区域 | us-east-1 |
| Bucket Name | 存储桶名称 | - |
| Storage Prefix | 同步对象的 S3 前缀路径 | `_obsidian-sync/` |
| Force Path Style | MinIO 等服务需开启 | 关闭 |
| Device Name | 标识本设备（如"公司电脑"、"手机"） | 未命名设备 |
| Device ID | 自动生成的唯一标识（8 字符） | 自动生成 |
| Auto Sync | 启用定时自动同步 | 关闭 |
| Sync Interval | 自动同步间隔（分钟） | 30 |
| Exclude Patterns | 排除的路径模式（逗号分隔的 glob） | `.obsidian,.trash` |
| Conditional Write | 利用 ETag 防止并发覆盖 | 开启 |
| Orphan Cleanup | 清理未引用的云端对象 | 关闭 |

## 开发

```bash
npm i          # 安装依赖
npm run dev    # 开发模式（esbuild 监听编译）
npm run build  # 生产构建（TypeScript 类型检查 + esbuild 压缩）
npx jest       # 运行测试
npm run lint   # ESLint 检查
```

## 项目结构

```
src/
  main.ts           # 插件入口，观察者事件，同步协调，状态栏
  scanner.ts        # 文件扫描器，版本链模型，SHA-256 哈希，diff 算法
  transfer.ts       # S3 传输管理器，并发池，内容寻址存储
  settings.ts       # 插件设置 UI 与默认配置
  ConflictModal.ts  # 冲突解决模态框
tests/
  __mocks__/obsidian.ts  # Obsidian API mock
  scanner.test.ts        # 扫描器与 diff 算法测试
  main.test.ts           # 插件行为测试
  transfer.test.ts       # 传输管理器测试
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript（严格模式，ES2018） |
| 平台 | Obsidian Plugin API |
| 打包器 | esbuild（CJS） |
| S3 客户端 | @aws-sdk/client-s3 v3 |
| 测试 | Jest 30 + ts-jest |
| 代码检查 | ESLint 9 + typescript-eslint |

## 许可证

[0BSD](LICENSE)

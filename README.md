# S3 Manifest-Sync

---

## 中文

### 这是什么？

S3 Manifest-Sync 是一个 Obsidian 插件，用于在多个设备之间通过 S3 兼容对象存储（如腾讯云 COS、AWS S3、Cloudflare R2 等）**增量同步**你的 Obsidian Vault 文件。

与简单的全量备份不同，本插件采用 **Manifest + 版本链** 架构，只传输真正发生变化的文件，大幅减少带宽消耗和同步时间。

### 核心特性

- **增量同步**：基于版本链（version chain）+ SHA-256 内容哈希，只上传/下载真正变化的文件
- **多设备协同**：每台设备拥有独立 deviceId，manifest 记录全局文件状态，不同设备修改不同文件时自动合并
- **冲突检测**：当两台设备同时修改同一文件时，自动检测冲突并提示用户选择（本地/云端/双份副本）
- **墓碑机制**：删除操作通过 tombstone 传播到所有设备，防止已删除文件被其他设备"复活"
- **哈希缝合**：冷启动或换设备时，如果本地和云端文件内容相同（SHA-256 一致），直接编入账本，无需传输
- **二进制文件支持**：自动识别图片、PDF、音视频等二进制格式，使用 readBinary/writeBinary 保证数据完整性
- **并发传输**：上传/下载/删除支持并发池（最大 3 并发），带自动重试（最多 3 次）
- **条件写入**：manifest.json 使用 IfMatch/IfNoneMatch 条件写入，防止并发覆盖
- **同步锁**：同步过程中自动静默 Observer 事件，避免"下载→触发 modify→又上传"的回声死循环
- **Android 友好**：适配移动端 Obsidian，支持弱网环境下的增量同步

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

### 配置项

| 配置 | 说明 |
|------|------|
| Access Key / Secret Key | S3 兼容存储的访问密钥 |
| Endpoint | 存储服务端点（如 `https://cos.ap-beijing.myqcloud.com`） |
| Region | 存储桶所在区域 |
| Bucket Name | 存储桶名称 |
| 设备名称 | 标识本设备（如"公司电脑"、"手机"） |
| 自动同步 | 启用后按设定间隔自动同步 |
| 同步间隔 | 自动同步的时间间隔（分钟） |
| 排除模式 | 不同步的路径模式（如 `.obsidian,.trash`） |

### 安装

1. 下载 `main.js`、`manifest.json`、`styles.css`
2. 复制到 Vault 的 `.obsidian/plugins/s3-manifest-sync/` 目录
3. 在 Obsidian 设置中启用插件
4. 填写 S3 配置并点击"测试连接"

### 开发

```bash
npm i          # 安装依赖
npm run dev    # 开发模式（监听编译）
npm run build  # 生产构建
npx jest       # 运行测试
```

---

## English

### What is this?

S3 Manifest-Sync is an Obsidian plugin that **incrementally synchronizes** your Obsidian Vault files across multiple devices via S3-compatible object storage (e.g., Tencent COS, AWS S3, Cloudflare R2, etc.).

Unlike simple full backups, this plugin uses a **Manifest + Version Chain** architecture, transferring only files that have actually changed — dramatically reducing bandwidth usage and sync time.

### Key Features

- **Incremental Sync**: Based on version chain + SHA-256 content hashing, only uploads/downloads files with real changes
- **Multi-Device Coordination**: Each device has a unique deviceId; the manifest records global file state; changes to different files on different devices merge automatically
- **Conflict Detection**: When two devices modify the same file simultaneously, conflicts are detected and the user is prompted to choose (local / cloud / both copies)
- **Tombstone Mechanism**: Deletions propagate to all devices via tombstones, preventing deleted files from being "resurrected" by other devices
- **Hash Stitching**: On cold start or device switch, if local and cloud files have identical content (SHA-256 match), they are stitched into the ledger without transfer
- **Binary File Support**: Automatically detects images, PDFs, audio/video, etc., using readBinary/writeBinary to ensure data integrity
- **Concurrent Transfer**: Upload/download/delete use a concurrency pool (max 3 concurrent), with automatic retry (up to 3 attempts)
- **Conditional Write**: manifest.json uses IfMatch/IfNoneMatch conditional writes to prevent concurrent overwrites
- **Sync Lock**: Observer events are automatically silenced during sync, preventing the "download → triggers modify → re-upload" echo loop
- **Android Friendly**: Adapts to mobile Obsidian, supports incremental sync in weak network environments

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

### Configuration

| Setting | Description |
|---------|-------------|
| Access Key / Secret Key | S3-compatible storage access credentials |
| Endpoint | Storage service endpoint (e.g., `https://cos.ap-beijing.myqcloud.com`) |
| Region | Storage bucket region |
| Bucket Name | Storage bucket name |
| Device Name | Identifies this device (e.g., "Work Laptop", "Phone") |
| Auto Sync | Enable periodic automatic sync |
| Sync Interval | Automatic sync interval in minutes |
| Exclude Patterns | Path patterns to skip (e.g., `.obsidian,.trash`) |

### Installation

1. Download `main.js`, `manifest.json`, `styles.css`
2. Copy to your Vault's `.obsidian/plugins/s3-manifest-sync/` directory
3. Enable the plugin in Obsidian settings
4. Fill in S3 configuration and click "Test Connection"

### Development

```bash
npm i          # Install dependencies
npm run dev    # Development mode (watch compile)
npm run build  # Production build
npx jest       # Run tests
```

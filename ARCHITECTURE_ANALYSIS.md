# S3 Manifest-Sync 架构分析

本文档记录当前源码状态，避免旧风险清单误导后续开发。当前版本目标是 Obsidian Vault 与 S3/COS 兼容存储之间的 manifest 驱动同步。

## 当前架构

### scanner.ts

- `FileState` 使用 `fileId / version / baseVersion / contentHash / parentHash / objectKey` 表达文件版本链。
- `DeletedEntry` 使用 `version / baseVersion / contentHash / ackedBy` 表达删除墓碑。
- `computeSyncDelta()` 输出上传、下载、云端删除、本地删除、冲突、哈希缝合和墓碑发布队列。
- `FileScanner.scanAll()` 用于完整扫描；`scanPaths()` 用于 pending-only 快速同步。
- `isSyncTargetPath()` 是同步目标过滤的唯一公共规则：排除系统文件、根目录旧版 `manifest.json`、插件存储前缀和用户排除规则；不再全局排除子目录中的 `manifest.json`。

### transfer.ts

- 云端控制文件位于 `_obsidian-sync/manifest.json`，可通过 `storagePrefix` 配置。
- 文件对象使用内容寻址：`_obsidian-sync/objects/{hashPrefix}/{sha256}`。
- 上传前始终按实际读取的 bytes 重新计算 SHA-256；内容寻址 key 和 manifest hash 不再信任扫描阶段的旧 hash。
- 下载后始终计算实际 SHA-256，并与 manifest 中的 `contentHash` 校验。
- 下载前递归创建父目录。
- 下载覆盖和本地删除前会重新校验当前磁盘内容是否仍等于扫描快照；如果用户同步期间改过文件，会转入冲突处理而不是覆盖或删除。
- 旧版路径式对象兼容：下载时始终按 `manifest.objectKey → hash 推导内容寻址 key → 旧路径 key` 顺序尝试；旧路径下载成功后会重新上传到内容寻址位置并更新 manifest。
- `fetchCloudManifest()` 只有 404 / NoSuchKey / NotFound 会返回空 manifest；其他错误会抛出并中止同步。
- `uploadManifest()` 使用 `IfMatch` / `IfNoneMatch` 条件写入，避免并发覆盖。
- `cleanOrphanFiles()` 需要 `enableOrphanCleanup` 显式开启，只扫描插件 `objects/` 前缀，只清理未引用且超过 24 小时的对象；默认不在 full sync 中自动执行。

### main.ts

- 修改、创建、删除、重命名事件统一使用 `isSyncTargetPath()` 过滤。
- `localLedger`、`localTombstones` 和 `pendingPaths` 启动时会清理非法路径。
- 修改、删除、重命名会立即持久化账本、墓碑和 pending 路径。
- `pendingPaths` 不在同步开始前清空，只在 manifest 成功提交后按本次快照清除。
- 桌面端实现定时自动同步；移动端依赖事件防抖、pending-only quick sync 和页面隐藏时的 flush 尝试。
- 桌面端冲突弹窗已接入；移动端默认保留双份副本。
- manifest 条件写入失败时会加入随机退避，重新拉取云端状态并最多尝试 3 次；仍失败则保留 pending，等待下次同步。
- 静默同步不会弹每文件进度 Notice，只保留日志和最终状态。
- 同步写入使用 path-level suppress；下载写入回声通过“当前磁盘 hash 是否等于同步刚写入 hash”识别，避免固定时间窗口吞掉用户真实修改。

### ConflictModal.ts

- 提供“以本地为准 / 以云端为准 / 保留双份副本”三种选择。
- 如果用户关闭弹窗但未选择，会默认 resolve 为 `both`，避免同步锁卡死。

## 已修复的高风险问题

| 问题 | 当前状态 |
| --- | --- |
| manifest 获取失败返回空导致误删 | 已修复：非 404 错误抛出 |
| fullSync 自动 orphan clean | 已修复：默认不自动执行 |
| 真实路径对象并发覆盖 | 已修复：内容寻址对象 |
| 根路径控制 manifest 冲突 | 已修复：控制文件移入插件前缀 |
| 下载相信 metadata hash | 已修复：校验真实 bytes hash |
| 下载深层文件缺父目录 | 已修复：下载前创建父目录 |
| 外部删除导致文件复活 | 已修复：启动核对生成 tombstone |
| quickSync 全量 scanAll | 已修复：pending-only scanPaths |
| 删除未进入 pending | 已修复：删除路径加入 pending |
| pending 同步前清空 | 已修复：提交成功后清除 |
| 冲突弹窗关闭卡死 | 已修复：关闭默认保留双份 |
| 旧版路径对象无法下载 | 已修复：旧路径 fallback + 内容寻址迁移 |
| cloud 缺 clean 本地文件条目 | 已修复：保守 repair upload |
| local tombstone 无 cloud 文件时不发布 | 已修复：发布到 `deleted` map |
| manifest IfMatch 并发失败需要手动等下次同步 | 已修复：随机退避并最多自动 rebase 3 次 |
| 静默同步逐文件弹 Notice | 已修复：静默模式下禁用逐文件 Notice |
| orphan cleanup 开关语义不清 | 已修复：改为手动清理授权开关 |
| 全局 `isSyncing` 吞掉同步期间用户编辑 | 已修复：改为 path-level suppress |
| quickSync 扫描所有 tombstone 路径 | 已修复：只扫描非 tombstone 的 pending 路径 |
| 同步期间用户改动可能被下载覆盖或云端 tombstone 删除 | 已修复：写入/删除前校验当前磁盘 hash，变化则转入冲突 |
| direct `cleanOrphanFiles()` 调用可绕过设置页开关 | 已修复：transfer 层也检查 `enableOrphanCleanup` |
| 上传时扫描 hash 与实际读取 bytes 不一致 | 已修复：对象 key 和 manifest hash 均使用实际上传 bytes hash |
| suppress 固定时间窗口吞掉用户同步后立即编辑 | 已修复：写入回声改为 hash-aware 判断 |

## 仍需关注

- Android 后台 flush 仍受系统杀进程限制；当前策略是尽早持久化事实并让下次启动恢复 pending。
- 墓碑仍长期保留；后续应基于设备 ack 或安全窗口做压缩，而不是按固定时间删除。

## 当前风险等级

当前版本适合测试库、备份库和小规模 Vault 试跑。进入稳定版前建议补充：

- 真实 COS/S3 的双桌面端并发同步测试。
- 桌面 + Android 的修改、删除、重命名、冲突、离线后恢复测试。
- manifest 条件写入失败自动 rebase 的真实 COS 并发验证。
- 大 Vault 下 quick sync 与 full sync 的耗时测试。

# 本机运行时数据

本目录承载 Ebbinghaus 的正式本机数据，但除本说明文件外，所有内容均被 Git 忽略。
应用启动时按需创建下列目录，不要求开发者手工维护：

```text
data/
├── runtime/                  # 正式 SQLite 数据库及其 WAL、SHM 边车文件
├── backups/                  # 结构迁移前生成的只增不自动删除备份
├── logs/                     # 本机运行日志，不记录密钥或完整释义正文
├── cache/                    # 可丢弃的网络响应等非权威缓存
└── config/                   # 本机专用设置；访问密钥不得提交到 Git
```

默认正式数据库路径为 `data/runtime/ebbinghaus.sqlite3`（源码启动）。正式打包应用
`Ebbinghaus.app` 不使用本目录，其数据根目录为 `~/Library/Application Support/Ebbinghaus/`，
两者互不影响。所有路径必须由
`src/ebbinghaus/bootstrap/paths.py` 统一解析；测试必须显式覆盖数据根目录，禁止连接此处的
正式数据库。

SQLite 数据库是正式学习数据的唯一真理源。后续升级必须先通过 SQLite 在线备份接口写入
`data/backups/`，再执行可回滚的向前迁移；不得通过直接复制一个正在写入的数据库文件来备份。

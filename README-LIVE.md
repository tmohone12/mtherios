# Live MythEngine

Start.bat and start.ps1 now launch the durable installed app at http://127.0.0.1:5173 through E:\DEV\Projects\MythEngine-runtime\Start-MythEngine.ps1.

Live source is maintained on the live-stable branch in E:\DEV\Projects\MythEngine-runtime\source. This original checkout's uncommitted source is preserved. Review and merge changes into the maintained source, then run Update-Live.cmd to stage a checked immutable build. Building this original checkout alone does not update live.

See E:\DEV\Projects\MythEngine-runtime\README.md for guarded update, fresh backup and rollback commands. Production database, data, vaults and current story progress remain at their original paths. Global workers, automatic indexing and chapter dispatch remain paused.

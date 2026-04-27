#!/bin/bash
# Obsidian 插件打包脚本 — 将编译产物打包为可分发 zip

set -e

PLUGIN_ID="s3-manifest-sync"
DIST_DIR="dist_package"
ZIP_NAME="${PLUGIN_ID}.zip"

# 清理旧产物
rm -rf "$DIST_DIR"
rm -f "$ZIP_NAME"

# 创建临时目录
mkdir "$DIST_DIR"

# 拷贝必需文件（styles.css 仅在存在时拷贝）
cp main.js "$DIST_DIR/"
cp manifest.json "$DIST_DIR/"
if [ -f styles.css ]; then
	cp styles.css "$DIST_DIR/"
fi

# 打包为 zip
cd "$DIST_DIR"
zip -r "../$ZIP_NAME" ./*
cd ..

# 删除临时目录
rm -rf "$DIST_DIR"

echo "打包完成：${ZIP_NAME}"
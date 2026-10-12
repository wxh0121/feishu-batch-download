// 检查库是否已加载
function checkLibrariesLoaded() {
    if (typeof JSZip === 'undefined') {
        throw new Error('JSZip 库未加载');
    }
    if (typeof saveAs === 'undefined') {
        throw new Error('FileSaver 库未加载');
    }
}


// 等待库加载完成（库文件已经在manifest.json中自动加载）
function waitForLibraries(maxAttempts = 20) {
    // 由于库文件已经在manifest.json的content_scripts中声明，它们应该已经加载
    // 但为了安全起见，我们等待一小段时间确保它们完全初始化
    return new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
            attempts++;
            try {
                checkLibrariesLoaded();
                console.log('库加载完成');
                resolve(true);
            } catch (error) {
                // 如果库还没加载，等待一下再试
                if (attempts < maxAttempts && (typeof JSZip === 'undefined' || typeof saveAs === 'undefined')) {
                    setTimeout(check, 100);
                } else {
                    console.error('库加载失败:', error);
                    console.log('JSZip 状态:', typeof JSZip);
                    console.log('saveAs 状态:', typeof saveAs);
                    resolve(false);
                }
            }
        };
        // 立即检查一次，如果失败则等待
        check();
    });
}

// 等待面板元素创建完成
function waitForPanel() {
    return new Promise((resolve) => {
        const check = () => {
            const panel = document.getElementById('feishu-download-panel');
            const loadFilesBtn = document.getElementById('loadFilesBtn');
            if (panel && loadFilesBtn) {
                resolve();
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
}

// 初始化应用
async function initializeApp() {
    // 等待面板创建
    await waitForPanel();
    
    // 等待库加载（最多等待2秒）
    const libsLoaded = await Promise.race([
        waitForLibraries(),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000))
    ]);
    
    if (!libsLoaded) {
        const errorContainer = document.getElementById('error');
        const errorContent = document.getElementById('errorContent');
        if (errorContainer && errorContent) {
            errorContainer.style.display = 'block';
            errorContent.textContent = 'JSZip 或 FileSaver 库加载失败。请确保 jszip.min.js 和 FileSaver.min.js 文件存在于扩展目录中，并且已刷新扩展。';
        }
        return;
    }
    
    console.log('面板初始化完成');
    
    const loadFilesBtn = document.getElementById('loadFilesBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectNoneBtn = document.getElementById('selectNoneBtn');
    const fileListContainer = document.getElementById('fileListContainer');
    const fileList = document.getElementById('fileList');
    const fileCount = document.getElementById('fileCount');
    const errorContainer = document.getElementById('error');
    const errorContent = document.getElementById('errorContent');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const loadingProgress = document.getElementById('loadingProgress');
    const loadingProgressFill = document.getElementById('loadingProgressFill');
    const loadingDetail = document.getElementById('loadingDetail');
    const resultContainer = document.getElementById('result');
    const resultContent = document.getElementById('resultContent');
    
    let treeData = [];
    let allFilesFlat = []; // 扁平化的所有文件列表，用于下载
    // 同一个文件（相同 obj_token）可能同时出现在多个文件夹中（如快捷方式），
    // 因此按树中每个文件节点的实例来记录勾选状态，而不是按 obj_token
    let selectedFiles = new Set(); // 选中的文件节点 key
    let fileEntries = new Map(); // key -> { node, folderPath }

    // 从树形结构中收集所有文件（扁平化，去重）
    function collectAllFiles(nodes, fileList = [], seenTokens = new Set()) {
        nodes.forEach(node => {
            if (node.type === 'file') {
                // 去重：只添加未添加过的文件
                if (!seenTokens.has(node.obj_token)) {
                    fileList.push(node);
                    seenTokens.add(node.obj_token);
                } else {
                    console.warn(`[collectAllFiles] 跳过重复文件: ${node.name} (${node.obj_token})`);
                }
            } else if (node.type === 'folder' && node.children) {
                collectAllFiles(node.children, fileList, seenTokens);
            }
        });
        return fileList;
    }

    let scanTimer = null; // 获取文件列表时每秒刷新已用时间
    let scanStartTime = 0;
    let lastScanProgress = null;

    function hideResults() {
        resultContainer.style.display = 'none';
        errorContainer.style.display = 'none';
        loading.style.display = 'none';
        if (scanTimer) {
            clearInterval(scanTimer);
            scanTimer = null;
        }
    }

    function showLoading(text = '正在处理...') {
        hideResults();
        loading.style.display = 'block';
        loadingText.textContent = text;
        setProgress(null, '');
        loadFilesBtn.disabled = true;
        downloadBtn.disabled = true;
    }

    // 更新进度条：percent 为 0~1；传 'indeterminate' 显示不确定进度的动画；传 null 隐藏进度条
    function setProgress(percent, detail) {
        if (percent === null) {
            loadingProgress.style.display = 'none';
        } else {
            loadingProgress.style.display = 'block';
            const indeterminate = percent === 'indeterminate';
            loadingProgress.classList.toggle('indeterminate', indeterminate);
            loadingProgressFill.style.width = indeterminate ? '' : `${Math.round(percent * 100)}%`;
        }
        loadingDetail.textContent = detail;
    }

    function formatElapsed(ms) {
        const sec = Math.floor(ms / 1000);
        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }

    function renderScanProgress() {
        const p = lastScanProgress || { topDone: 0, topTotal: 0, folders: 0, files: 0, currentPath: '' };
        const elapsed = formatElapsed(Date.now() - scanStartTime);
        const lines = [`已扫描 ${p.folders} 个文件夹，发现 ${p.files} 个文件 · 已用时 ${elapsed}`];
        if (p.currentPath) {
            lines.push(`当前：${p.currentPath}`);
        }
        if (p.topTotal > 0) {
            const done = p.topDone >= p.topTotal;
            loadingText.textContent = done
                ? '扫描完成，正在整理文件列表...'
                : `正在扫描文件夹 (${p.topDone}/${p.topTotal})...`;
            setProgress(p.topDone / p.topTotal, lines.join('\n'));
        } else {
            loadingText.textContent = '正在获取文件夹列表...';
            setProgress('indeterminate', lines.join('\n'));
        }
    }

    window.addEventListener('fileListProgress', function(event) {
        lastScanProgress = event.detail;
        if (scanTimer) {
            renderScanProgress();
        }
    });

    function showError(error) {
        hideResults();
        loading.style.display = 'none';
        errorContainer.style.display = 'block';
        errorContent.textContent = error;
        loadFilesBtn.disabled = false;
        downloadBtn.disabled = false;
    }

    function showResult(content) {
        hideResults();
        loading.style.display = 'none';
        resultContainer.style.display = 'block';
        resultContent.innerHTML = content;
        loadFilesBtn.disabled = false;
        downloadBtn.disabled = false;
    }

    // 渲染树形结构
    function renderFileList(tree) {
        treeData = tree;
        selectedFiles.clear();
        fileEntries.clear();
        allFilesFlat = collectAllFiles(tree);
        fileList.innerHTML = '';
        
        // 递归渲染节点
        function renderNode(node, level = 0, container, parentPath = '') {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.style.paddingLeft = `${level * 20 + 8}px`;
            
            if (node.type === 'folder') {
                // 文件夹
                const folderContainer = document.createElement('div');
                folderContainer.className = 'folder-container';
                folderContainer.dataset.folderToken = node.obj_token;
                
                const hasChildren = node.children && node.children.length > 0;
                const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
                
                // 展开/收起图标（只有有子节点才显示）
                if (hasChildren) {
                    const expandIcon = document.createElement('span');
                    expandIcon.className = 'expand-icon';
                    expandIcon.textContent = '▶';
                    expandIcon.style.marginRight = '4px';
                    expandIcon.style.cursor = 'pointer';
                    expandIcon.style.fontSize = '10px';
                    expandIcon.style.color = '#666';
                    item.appendChild(expandIcon);
                } else {
                    // 空文件夹，显示占位符
                    const spacer = document.createElement('span');
                    spacer.style.marginRight = '4px';
                    spacer.style.width = '12px';
                    spacer.style.display = 'inline-block';
                    item.appendChild(spacer);
                }
                
                // 文件夹复选框：勾选即选中该文件夹下的全部文件（含子文件夹）
                const folderCheckbox = document.createElement('input');
                folderCheckbox.type = 'checkbox';
                folderCheckbox.className = 'folder-checkbox';
                folderCheckbox.title = '仅下载当前文件夹内容';
                if (!hasChildren) {
                    folderCheckbox.disabled = true;
                }
                folderCheckbox.addEventListener('click', function(e) {
                    e.stopPropagation();
                });
                folderCheckbox.addEventListener('change', function() {
                    const fileCheckboxes = folderContainer.querySelectorAll('input.file-checkbox');
                    fileCheckboxes.forEach(cb => {
                        if (this.checked) {
                            selectedFiles.add(cb.value);
                        } else {
                            selectedFiles.delete(cb.value);
                        }
                    });
                    syncCheckboxes();
                    updateDownloadButton();
                });
                item.appendChild(folderCheckbox);
                
                // 文件夹图标
                const folderIcon = document.createElement('span');
                folderIcon.textContent = '📁';
                folderIcon.style.marginRight = '8px';
                
                // 文件夹名称
                const folderName = document.createElement('span');
                folderName.textContent = node.name;
                folderName.style.fontWeight = '600';
                folderName.style.color = '#667eea';
                if (hasChildren) {
                    folderName.style.cursor = 'pointer';
                }
                
                item.appendChild(folderIcon);
                item.appendChild(folderName);
                
                // 子节点容器（默认隐藏）
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'folder-children';
                childrenContainer.style.display = 'none';
                childrenContainer.dataset.parentToken = node.obj_token;
                
                // 点击文件夹展开/收起（只有有子节点才能点击）
                if (hasChildren) {
                    const toggleFolder = (e) => {
                        if (e) {
                            e.stopPropagation();
                        }
                        const isExpanded = childrenContainer.style.display !== 'none';
                        if (isExpanded) {
                            childrenContainer.style.display = 'none';
                            const icon = item.querySelector('.expand-icon');
                            if (icon) icon.textContent = '▶';
                        } else {
                            childrenContainer.style.display = 'block';
                            const icon = item.querySelector('.expand-icon');
                            if (icon) icon.textContent = '▼';
                        }
                    };
                    
                    // 整行都可以点击（除了复选框）
                    item.addEventListener('click', (e) => {
                        // 如果点击的是复选框或其他交互元素，不触发展开/收起
                        if (e.target.type === 'checkbox' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') {
                            return;
                        }
                        toggleFolder(e);
                    });
                    item.style.cursor = 'pointer';
                    item.style.userSelect = 'none';
                }
                
                folderContainer.appendChild(item);
                
                // 如果有子节点，递归渲染
                if (node.children && node.children.length > 0) {
                    node.children.forEach(child => {
                        renderNode(child, level + 1, childrenContainer, folderPath);
                    });
                    folderContainer.appendChild(childrenContainer);
                }
                
                if (container) {
                    container.appendChild(folderContainer);
                } else {
                    fileList.appendChild(folderContainer);
                }
            } else {
                // 文件
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'file-checkbox';
                const fileKey = `f${fileEntries.size}`;
                fileEntries.set(fileKey, { node, folderPath: parentPath });
                checkbox.id = `file-${fileKey}`;
                checkbox.value = fileKey;
                
                checkbox.addEventListener('change', function() {
                    if (this.checked) {
                        selectedFiles.add(fileKey);
                    } else {
                        selectedFiles.delete(fileKey);
                    }
                    syncCheckboxes();
                    updateDownloadButton();
                });
                
                // 阻止复选框点击事件冒泡
                checkbox.addEventListener('click', function(e) {
                    e.stopPropagation();
                });
                
                const fileIcon = document.createElement('span');
                fileIcon.textContent = '📄';
                fileIcon.style.marginRight = '8px';
                
                const label = document.createElement('span'); // 改为span，不使用label标签
                label.className = 'file-item-label';
                label.textContent = node.name;
                label.style.cursor = 'pointer';
                
                const info = document.createElement('span');
                info.className = 'file-item-info';
                info.textContent = getFileTypeName(node.obj_type);
                
                item.appendChild(checkbox);
                item.appendChild(fileIcon);
                item.appendChild(label);
                item.appendChild(info);
                
                // 给整个文件项添加点击事件，点击整行切换复选框
                item.addEventListener('click', function(e) {
                    // 如果点击的是复选框本身，不处理（由复选框自己的事件处理）
                    if (e.target === checkbox || e.target.type === 'checkbox') {
                        return;
                    }
                    
                    // 阻止事件冒泡，避免触发页面其他行为
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // 切换复选框状态
                    checkbox.checked = !checkbox.checked;
                    if (checkbox.checked) {
                        selectedFiles.add(fileKey);
                    } else {
                        selectedFiles.delete(fileKey);
                    }
                    syncCheckboxes();
                    updateDownloadButton();
                });
                
                // 设置文件项样式，使其看起来可点击
                item.style.cursor = 'pointer';
                
                if (container) {
                    container.appendChild(item);
                } else {
                    fileList.appendChild(item);
                }
            }
        }
        
        // 渲染所有根节点（从上往下）
        tree.forEach(rootNode => {
            renderNode(rootNode, 0, null);
        });
        
        syncCheckboxes();
        fileCount.textContent = allFilesFlat.length;
        fileListContainer.style.display = 'block';
        downloadBtn.style.display = 'block';
        updateDownloadButton();
    }

    function getFileTypeName(objType) {
        const typeMap = {
            8: '多维表',
            3: '表格',
            30: '幻灯片',
            2: '文档',
            22: '文档',
            11: '思维笔记'
        };
        return typeMap[objType] || '未知';
    }

    // 根据 selectedFiles 同步所有复选框状态：
    // 文件复选框直接对应；文件夹复选框根据其下文件计算 全选/部分选中(半选)/未选
    function syncCheckboxes() {
        fileList.querySelectorAll('input.file-checkbox').forEach(cb => {
            cb.checked = selectedFiles.has(cb.value);
        });
        fileList.querySelectorAll('.folder-container').forEach(folderContainer => {
            const folderCheckbox = folderContainer.querySelector(':scope > .file-item > input.folder-checkbox');
            if (!folderCheckbox) return;
            const fileCheckboxes = folderContainer.querySelectorAll('input.file-checkbox');
            let checkedCount = 0;
            fileCheckboxes.forEach(cb => {
                if (cb.checked) checkedCount++;
            });
            folderCheckbox.checked = fileCheckboxes.length > 0 && checkedCount === fileCheckboxes.length;
            folderCheckbox.indeterminate = checkedCount > 0 && checkedCount < fileCheckboxes.length;
        });
    }

    // 按显示顺序取出选中的文件；同一文件在多个文件夹中都被选中时只下载一次
    function getFilesToDownload() {
        const result = [];
        const seenTokens = new Set();
        fileEntries.forEach((entry, key) => {
            if (!selectedFiles.has(key) || seenTokens.has(entry.node.obj_token)) return;
            seenTokens.add(entry.node.obj_token);
            result.push(entry);
        });
        return result;
    }

    function updateDownloadButton() {
        const count = getFilesToDownload().length;
        if (count > 0) {
            downloadBtn.textContent = `下载选中文件 (${count})`;
            downloadBtn.disabled = false;
        } else {
            downloadBtn.textContent = '下载选中文件';
            downloadBtn.disabled = true;
        }
    }

    // 获取所有文件
    loadFilesBtn.addEventListener('click', async function() {
        showLoading('正在获取文件列表...');
        scanStartTime = Date.now();
        lastScanProgress = null;
        renderScanProgress();
        scanTimer = setInterval(renderScanProgress, 1000);

        try {
            // 通过window事件请求文件列表（content.js会监听）
            window.dispatchEvent(new CustomEvent('requestAllFiles'));
        } catch (error) {
            showError('发生错误: ' + error.message);
        }
    });
    
    // 监听文件列表就绪事件
    window.addEventListener('fileListReady', function(event) {
        const { tree, error } = event.detail;
        if (error) {
            showError(error);
        } else if (tree && tree.length > 0) {
            renderFileList(tree);
            hideResults();
        } else {
            showError('未找到文件，请确保您有访问权限');
        }
    });

    // 全选
    selectAllBtn.addEventListener('click', function() {
        fileEntries.forEach((entry, key) => selectedFiles.add(key));
        syncCheckboxes();
        updateDownloadButton();
    });

    // 全不选
    selectNoneBtn.addEventListener('click', function() {
        selectedFiles.clear();
        syncCheckboxes();
        updateDownloadButton();
    });
    
    // 批量下载
    downloadBtn.addEventListener('click', async function() {
        // 再次检查库是否已加载
        try {
            checkLibrariesLoaded();
        } catch (error) {
            showError('JSZip 或 FileSaver 库未加载，请刷新页面重试');
            return;
        }
        
        if (selectedFiles.size === 0) {
            showError('请至少选择一个文件');
            return;
        }

        const filesToDownload = getFilesToDownload();
        console.log('[下载] 选中的文件数量:', selectedFiles.size);
        console.log('[下载] 所有文件数量:', allFilesFlat.length);
        console.log('[下载] 要下载的文件数量:', filesToDownload.length);
        console.log('[下载] 要下载的文件列表:', filesToDownload.map(e => e.node.name));
        
        await downloadEntries(filesToDownload, false);
    });

    // 下载一批文件并打包；isRetry 表示是重试上一次失败的文件
    async function downloadEntries(filesToDownload, isRetry) {
        showLoading(`正在${isRetry ? '重试' : '下载'} ${filesToDownload.length} 个文件...`);

        try {
            const zip = new JSZip();
            let successCount = 0;
            const failedFiles = []; // { path, reason, entry }

            // 批量下载文件（按顺序下载）
            for (let i = 0; i < filesToDownload.length; i++) {
                const { node: file, folderPath } = filesToDownload[i];
                const displayPath = folderPath ? `${folderPath}/${file.name}` : file.name;
                loadingText.textContent = `正在${isRetry ? '重试' : '下载'} ${i + 1}/${filesToDownload.length}: ${file.name}`;
                setProgress(i / filesToDownload.length,
                    `已完成 ${i}/${filesToDownload.length}，成功 ${successCount} 个，失败 ${failedFiles.length} 个`);
                
                try {
                    // 等待下载完成（通过window事件）
                    const response = await new Promise((resolve) => {
                        const requestId = Math.random().toString(36).substring(2, 11);
                        
                        // 监听响应
                        const handler = (event) => {
                            if (event.detail.requestId === requestId) {
                                window.removeEventListener('fileDownloaded', handler);
                                resolve(event.detail.response);
                            }
                        };
                        window.addEventListener('fileDownloaded', handler);
                        
                        // 发送下载请求
                        window.dispatchEvent(new CustomEvent('requestDownloadFile', {
                            detail: {
                                requestId: requestId,
                                obj_token: file.obj_token,
                                obj_type: file.obj_type,
                                fileName: file.name
                            }
                        }));
                        
                        // 超时处理
                        setTimeout(() => {
                            window.removeEventListener('fileDownloaded', handler);
                            resolve({ success: false, error: '下载超时：5 分钟内未完成' });
                        }, 300000); // 5分钟超时
                    });
                    
                    if (response && response.success && response.dataUrl) {
                        // 从base64 data URL转换为ArrayBuffer
                        const base64Data = response.dataUrl.split(',')[1];
                        const binaryString = atob(base64Data);
                        const arrayBuffer = new Uint8Array(binaryString.length);
                        for (let j = 0; j < binaryString.length; j++) {
                            arrayBuffer[j] = binaryString.charCodeAt(j);
                        }
                        
                        // 优先使用飞书导出结果返回的扩展名
                        const extension = response.type || getFileExtension(file.obj_type);
                        // 文件名还没有对应扩展名时补上（名字里本身带点的，如“v1.2 报告”，也能正确补全）
                        let fileName = file.name;
                        if (!fileName.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
                            fileName = `${fileName}.${extension}`;
                        }
                        
                        // 直接放在所在文件夹下：文件夹/报告.docx
                        const fullPath = getUniquePath(zip, folderPath ? `${folderPath}/${fileName}` : fileName);
                        
                        zip.file(fullPath, arrayBuffer);
                        successCount++;
                        console.log(`文件 ${fullPath} 已添加到压缩包`);
                    } else {
                        const reason = response?.error || '未知原因';
                        failedFiles.push({ path: displayPath, reason, entry: filesToDownload[i] });
                        console.error(`下载文件失败: ${displayPath}`, reason);
                    }
                } catch (error) {
                    failedFiles.push({ path: displayPath, reason: `处理文件时出错：${error.message || error}`, entry: filesToDownload[i] });
                    console.error(`处理文件 ${displayPath} 时出错:`, error);
                }
            }

            // 有失败的文件时，在压缩包中附上失败清单
            if (failedFiles.length > 0) {
                const report = failedFiles
                    .map((f, idx) => `${idx + 1}. ${f.path}\n   原因：${f.reason}`)
                    .join('\n\n');
                zip.file('下载失败清单.txt', `共 ${failedFiles.length} 个文件下载失败：\n\n${report}\n`);
            }
            
            // 全部失败时不生成压缩包
            if (successCount > 0) {
                loadingText.textContent = '正在生成压缩包...';
                setProgress(1, `已完成 ${filesToDownload.length}/${filesToDownload.length}，成功 ${successCount} 个，失败 ${failedFiles.length} 个`);
                const content = await zip.generateAsync({ type: 'blob' });
                
                // 保存文件
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                saveAs(content, `飞书文件批量下载${isRetry ? '-重试' : ''}-${timestamp}.zip`);
            }
            
            const allFailed = successCount === 0;
            const statusColor = allFailed ? '#dc2626' : (failedFiles.length > 0 ? '#d97706' : '#10b981');
            const statusIcon = allFailed ? '✗' : (failedFiles.length > 0 ? '!' : '✓');
            const statusText = allFailed ? '全部下载失败' : (failedFiles.length > 0 ? '部分文件下载失败' : '下载完成');
            const zipNote = isRetry ? '（本次压缩包只包含重试成功的文件）' : '';
            
            const failedListHtml = failedFiles.length === 0 ? '' : `
                <div class="failed-list">
                    <div class="failed-list-title">失败的文件（${failedFiles.length} 个）${allFailed ? '' : '，清单已一并放入压缩包的「下载失败清单.txt」'}：</div>
                    ${failedFiles.map(f => `
                        <div class="failed-item">
                            <div class="failed-item-path">${escapeHtml(f.path)}</div>
                            <div class="failed-item-reason">${escapeHtml(f.reason)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
            
            showResult(`
                <div style="text-align: center; padding: 10px;">
                    <div style="font-size: 48px; margin-bottom: 10px; color: ${statusColor};">${statusIcon}</div>
                    <div style="color: ${statusColor}; font-weight: 600; margin-bottom: 8px; font-size: 16px;">${statusText}</div>
                    <div style="color: #666; font-size: 13px; margin-top: 5px;">
                        成功: ${successCount} 个<br>
                        ${failedFiles.length > 0 ? `失败: ${failedFiles.length} 个` : ''}
                        ${successCount > 0 ? `<br>${zipNote}` : ''}
                    </div>
                </div>
                ${failedFiles.length > 0 ? `<button id="retryFailedBtn" class="btn-primary">重试失败的文件 (${failedFiles.length})</button>` : ''}
                ${failedListHtml}
            `);
            
            if (failedFiles.length > 0) {
                const retryEntries = failedFiles.map(f => f.entry);
                document.getElementById('retryFailedBtn').addEventListener('click', () => {
                    downloadEntries(retryEntries, true);
                });
            }
        } catch (error) {
            showError('下载过程中发生错误: ' + error.message);
        }
    }

    // 同一文件夹下有同名文件时，加上序号避免在压缩包中互相覆盖：报告.docx → 报告 (2).docx
    function getUniquePath(zip, path) {
        if (!zip.file(path)) return path;
        const dotIndex = path.lastIndexOf('.');
        const base = dotIndex > path.lastIndexOf('/') ? path.slice(0, dotIndex) : path;
        const ext = dotIndex > path.lastIndexOf('/') ? path.slice(dotIndex) : '';
        let n = 2;
        while (zip.file(`${base} (${n})${ext}`)) n++;
        return `${base} (${n})${ext}`;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getFileExtension(objType) {
        const extMap = {
            8: 'xlsx',
            3: 'xlsx',
            30: 'pptx',
            2: 'docx',
            22: 'docx',
            11: 'mm'
        };
        return extMap[objType] || 'pdf';
    }
}

// 监听面板就绪事件或直接初始化
if (document.getElementById('feishu-download-panel')) {
    initializeApp();
} else {
    window.addEventListener('panelReady', initializeApp);
    // 如果面板已经存在，也尝试初始化
    setTimeout(() => {
        if (document.getElementById('feishu-download-panel')) {
            initializeApp();
        }
    }, 500);
}


import Storehouse from 'storehouse-js';
import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'github-markdown-css/github-markdown-light.css';

const init = () => {
    let hasEdited = false;
    let scrollBarSync = false;
    let currentTabId = 0;
    let tabs = [];

    const localStorageNamespace = 'com.markdownlivepreview';
    const localStorageKey = 'tabs_state';
    const localStorageScrollBarKey = 'scroll_bar_settings';
    const localStorageFontSizeKey = 'font_size_settings';
    const confirmationMessage = 'Are you sure you want to reset? Your changes will be lost.';

    // 字体大小设置
    const defaultFontSize = 14;
    const minFontSize = 10;
    const maxFontSize = 32;
    let currentFontSize = defaultFontSize;

    // 默认模板
    const defaultInput = `# Markdown syntax guide

## Headers

# This is a Heading h1
## This is a Heading h2
###### This is a Heading h6

## Emphasis

*This text will be italic*
_This will also be italic_

**This text will be bold**
__This will also be bold_

_You **can** combine them_

## Lists

### Unordered

* Item 1
* Item 2
* Item 2a
* Item 2b
    * Item 3a
    * Item 3b

### Ordered

1. Item 1
2. Item 2
3. Item 3
    1. Item 3a
    2. Item 3b

## Images

![This is an alt text.](/image/sample.webp "This is a sample image.")

## Links

You may be using [Markdown Live Preview](https://markdownlivepreview.com/).

## Blockquotes

> Markdown is a lightweight markup language with plain-text-formatting syntax, created in 2004 by John Gruber with Aaron Swartz.
>
>> Markdown is often used to format readme files, for writing messages in online discussion forums, and to create rich text using a plain text editor.

## Tables

| Left columns  | Right columns |
| ------------- |:-------------:|
| left foo      | right foo     |
| left bar      | right bar     |
| left baz      | right baz     |

## Blocks of code

\`\`\`javascript
let message = 'Hello world';
alert(message);
\`\`\`

## Inline code

This web site is using \`markedjs/marked\`.
`;

    self.MonacoEnvironment = {
        getWorker(_, label) {
            return new Proxy({}, { get: () => () => { } });
        }
    }

    let setupEditor = () => {
        let editor = monaco.editor.create(document.querySelector('#editor'), {
            fontSize: 14,
            language: 'markdown',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            scrollbar: {
                vertical: 'visible',
                horizontal: 'visible'
            },
            wordWrap: 'on',
            hover: { enabled: false },
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            folding: false
        });

        editor.onDidChangeModelContent(() => {
            hasEdited = true;
            let value = editor.getValue();
            convert(value);
            updateCurrentTabContent(value);

            // 只有在未手动重命名时才自动更新标题
            const currentTab = tabs.find(t => t.id === currentTabId);
            if (currentTab && !currentTab.isManuallyRenamed && value.trim() !== '') {
                const newTitle = extractTitleFromContent(value);
                updateCurrentTabTitle(newTitle);
                // 第一次自动更新标题后，标记为已命名，之后不再自动更新
                currentTab.isManuallyRenamed = true;
                saveTabsState();
            }
        });

        // 左侧滚动带动右侧
        editor.onDidScrollChange((e) => {
            if (!scrollBarSync) {
                return;
            }

            const scrollTop = e.scrollTop;
            const scrollHeight = e.scrollHeight;
            const height = editor.getLayoutInfo().height;

            const maxScrollTop = scrollHeight - height;
            if (maxScrollTop <= 0) return;
            const scrollRatio = scrollTop / maxScrollTop;

            let previewElement = document.querySelector('#preview');
            let targetY = (previewElement.scrollHeight - previewElement.clientHeight) * scrollRatio;
            previewElement.scrollTo(0, targetY);
        });

        return editor;
    };

    // 修复断行的表格行（将跨行的表格行合并为单行）
    let fixBrokenTableRows = (markdown) => {
        const lines = markdown.split('\n');
        const result = [];
        let inTable = false;
        let pendingRow = null;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();

            // 检测表格分隔行（如 | --- | --- |）
            if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
                inTable = true;
                if (pendingRow !== null) {
                    result.push(pendingRow);
                    pendingRow = null;
                }
                result.push(lines[i]);
                continue;
            }

            if (!inTable) {
                result.push(lines[i]);
                continue;
            }

            // 在表格上下文中
            if (trimmed === '') {
                if (pendingRow !== null) {
                    continue; // 跳过断行中的空行
                } else {
                    inTable = false;
                    result.push(lines[i]);
                    continue;
                }
            }

            if (pendingRow !== null) {
                // 将续行合并到未完成的行中
                pendingRow = pendingRow.trimEnd() + ' ' + trimmed;
                if (pendingRow.trim().endsWith('|')) {
                    result.push(pendingRow);
                    pendingRow = null;
                }
            } else if (trimmed.startsWith('|')) {
                if (trimmed.endsWith('|')) {
                    result.push(lines[i]);
                } else {
                    pendingRow = lines[i];
                }
            } else {
                // 非表格行，退出表格上下文
                inTable = false;
                result.push(lines[i]);
            }
        }

        if (pendingRow !== null) {
            result.push(pendingRow);
        }

        return result.join('\n');
    };

    // 修复CJK文本中加粗(**/__)因CommonMark标点规则无法解析的问题
    // 当 ** 前面是非空白/非标点字符（如CJK）且后面紧跟标点时，不满足左侧分隔符条件
    // 当 ** 前面是标点且后面紧跟非空白/非标点字符时，不满足右侧分隔符条件
    let fixCJKBoldEmphasis = (markdown) => {
        let inCodeBlock = false;
        const isNonWsNonPunct = (ch) => ch !== '' && !/[\s]/u.test(ch) && !/\p{P}/u.test(ch);

        return markdown.split('\n').map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                return line;
            }
            if (inCodeBlock) return line;

            return line.replace(/\*\*(.+?)\*\*/gu, (match, content, offset) => {
                const charBefore = offset > 0 ? line[offset - 1] : '';
                const afterEnd = offset + match.length;
                const charAfter = afterEnd < line.length ? line[afterEnd] : '';
                const firstChar = content[0];
                const lastChar = content[content.length - 1];

                // 开头 ** 失败：前面是非空白/非标点，后面是标点
                const openFail = isNonWsNonPunct(charBefore) && /\p{P}/u.test(firstChar);
                // 结尾 ** 失败：前面是标点，后面是非空白/非标点
                const closeFail = /\p{P}/u.test(lastChar) && isNonWsNonPunct(charAfter);

                if (openFail || closeFail) {
                    return `<strong>${content}</strong>`;
                }
                return match;
            });
        }).join('\n');
    };

    // 渲染 markdown 文本为 html
    let convert = (markdown) => {
        let options = {
            headerIds: false,
            mangle: false
        };
        let fixed = fixBrokenTableRows(markdown);
        fixed = fixCJKBoldEmphasis(fixed);
        let html = marked.parse(fixed, options);
        let sanitized = DOMPurify.sanitize(html);
        document.querySelector('#output').innerHTML = sanitized;
    };

    // 重置输入文本
    let reset = () => {
        let currentTab = tabs.find(t => t.id === currentTabId);
        let changed = currentTab.content !== defaultInput;
        if (hasEdited || changed) {
            var confirmed = window.confirm(confirmationMessage);
            if (!confirmed) {
                return;
            }
        }
        setEditorValue(defaultInput);
        updateCurrentTabContent(defaultInput);
        updateTabTitle(currentTabId, 'Untitled');
        document.querySelectorAll('.column').forEach((element) => {
            element.scrollTo({ top: 0 });
        });
        hasEdited = false;
    };

    let setEditorValue = (value) => {
        editor.setValue(value);
        editor.revealPosition({ lineNumber: 1, column: 1 });
        editor.focus();
    };

    // 同步滚动功能

    let initScrollBarSync = (settings) => {
        let checkbox = document.querySelector('#sync-scroll-checkbox');
        checkbox.checked = settings;
        scrollBarSync = settings;

        checkbox.addEventListener('change', (event) => {
            let checked = event.currentTarget.checked;
            scrollBarSync = checked;
            saveScrollBarSettings(checked);
        });
    };

    // 监听右侧预览滚动，实现双向同步
    let setupPreviewScrollSync = () => {
        let previewElement = document.querySelector('#preview');
        let isSyncing = false;

        previewElement.addEventListener('scroll', (e) => {
            if (!scrollBarSync) {
                return;
            }

            isSyncing = true;
            const scrollTop = e.target.scrollTop;
            const scrollHeight = e.target.scrollHeight;
            const height = e.target.clientHeight;

            const maxScrollTop = scrollHeight - height;
            if (maxScrollTop <= 0) {
                isSyncing = false;
                return;
            }

            const scrollRatio = scrollTop / maxScrollTop;
            const editorScrollHeight = editor.getScrollHeight();
            const editorHeight = editor.getLayoutInfo().height;
            const editorMaxScrollTop = editorScrollHeight - editorHeight;

            if (editorMaxScrollTop > 0) {
                const targetY = editorMaxScrollTop * scrollRatio;
                editor.setScrollTop(targetY);
            }

            // 使用 setTimeout 确保下一次滚动事件能够正常处理
            setTimeout(() => {
                isSyncing = false;
            }, 0);
        });
    };

    let enableScrollBarSync = () => {
        scrollBarSync = true;
    };

    let disableScrollBarSync = () => {
        scrollBarSync = false;
    };

    // 复制到剪贴板
    let copyToClipboard = (text, successHandler, errorHandler) => {
        navigator.clipboard.writeText(text).then(
            () => {
                successHandler();
            },

            () => {
                errorHandler();
            }
        );
    };

    let notifyCopied = () => {
        let labelElement = document.querySelector("#copy-button a");
        labelElement.innerHTML = "Copied!";
        setTimeout(() => {
            labelElement.innerHTML = "Copy";
        }, 1000)
    };

    // 设置重置按钮
    let setupResetButton = () => {
        document.querySelector("#reset-button").addEventListener('click', (event) => {
            event.preventDefault();
            reset();
        });
    };

    // 清空所有标签页
    let clearAllTabs = () => {
        const confirmed = window.confirm('Are you sure you want to clear all tabs? All content will be lost.');
        if (!confirmed) {
            return;
        }

        // 清空所有标签页，创建一个新的空白标签页
        tabs = [];
        createTab('', null);
        hasEdited = false;
    };

    // 设置清空所有按钮
    let setupClearAllButton = () => {
        document.querySelector("#clear-all-button").addEventListener('click', (event) => {
            event.preventDefault();
            clearAllTabs();
        });
    };

    let setupCopyButton = (editor) => {
        document.querySelector("#copy-button").addEventListener('click', (event) => {
            event.preventDefault();
            let value = editor.getValue();
            copyToClipboard(value, () => {
                notifyCopied();
            },
                () => {
                    // nothing to do
                });
        });
    };

    // 标签页管理功能

    // 从内容中提取第一行作为标题
    let extractTitleFromContent = (content) => {
        if (!content || content.trim() === '') {
            return 'Untitled';
        }

        const lines = content.split('\n');
        const firstLine = lines[0].trim();

        // 移除 markdown 标题符号
        let title = firstLine.replace(/^#+\s*/, '').replace(/^#/, '');

        // 如果第一行是空的或只有标题符号，使用第二行
        if (!title || title.trim() === '') {
            const secondLine = lines[1] ? lines[1].trim() : '';
            title = secondLine || 'Untitled';
        }

        // 限制标题长度
        if (title.length > 30) {
            title = title.substring(0, 30) + '...';
        }

        return title || 'Untitled';
    };

    let createTab = (content, title) => {
        const tabId = Date.now() + Math.random();
        const tabContent = content || '';

        const newTab = {
            id: tabId,
            title: title || extractTitleFromContent(tabContent),
            content: tabContent,
            isManuallyRenamed: !!title // 如果提供了标题，说明是手动设置的
        };

        // 只有在明确提供了自定义标题时才标记为手动重命名
        // 其他情况（包括自动生成的Untitled）都允许自动更新
        if (!title) {
            newTab.isManuallyRenamed = false;
        }

        tabs.push(newTab);
        renderTabs();
        switchToTab(tabId);
        saveTabsState();
        return tabId;
    };

    let deleteTab = (tabId) => {
        if (tabs.length === 1) {
            alert('Cannot delete the last tab');
            return;
        }

        const tabIndex = tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) return;

        tabs.splice(tabIndex, 1);

        if (currentTabId === tabId) {
            const newIndex = Math.max(0, tabIndex - 1);
            switchToTab(tabs[newIndex].id);
        }

        renderTabs();
        saveTabsState();
    };

    let switchToTab = (tabId) => {
        const tab = tabs.find(t => t.id === tabId);
        if (!tab) return;

        currentTabId = tabId;
        setEditorValue(tab.content);
        convert(tab.content);

        // 更新标签状态
        document.querySelectorAll('.tab').forEach(tabEl => {
            tabEl.classList.remove('active');
        });
        const activeTab = document.querySelector(`[data-tab-id="${tabId}"]`);
        if (activeTab) {
            activeTab.classList.add('active');
        }
    };

    let updateCurrentTabContent = (content) => {
        const tab = tabs.find(t => t.id === currentTabId);
        if (tab) {
            tab.content = content;
            saveTabsState();
        }
    };

    let updateTabTitle = (tabId, newTitle, markAsManual = false) => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            tab.title = newTitle;
            if (markAsManual) {
                tab.isManuallyRenamed = true;
            }
            renderTabs();
            saveTabsState();
        }
    };

    let updateCurrentTabTitle = (newTitle) => {
        const tab = tabs.find(t => t.id === currentTabId);
        if (tab) {
            tab.title = newTitle;
            renderTabs();
            saveTabsState();
        }
    };

    let renderTabs = () => {
        const container = document.querySelector('#tabs-container');
        container.innerHTML = '';

        tabs.forEach(tab => {
            const tabElement = document.createElement('div');
            tabElement.className = 'tab';
            tabElement.dataset.tabId = tab.id;

            if (tab.id === currentTabId) {
                tabElement.classList.add('active');
            }

            const tabText = document.createElement('span');
            tabText.className = 'tab-text';
            tabText.textContent = tab.title;
            tabText.title = tab.title;

            const tabClose = document.createElement('button');
            tabClose.className = 'tab-close';
            tabClose.innerHTML = '×';
            tabClose.title = 'Close tab';

            tabElement.appendChild(tabText);
            tabElement.appendChild(tabClose);

            // 双击编辑标签标题
            tabElement.addEventListener('dblclick', (e) => {
                if (e.target === tabClose) return;

                e.stopPropagation();
                const tabTextEl = tabElement.querySelector('.tab-text');
                const currentTitle = tab.title;

                // 创建输入框
                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentTitle;
                input.style.width = '100%';
                input.style.fontSize = '11px';
                input.style.border = 'none';
                input.style.outline = 'none';
                input.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
                input.style.padding = '2px 4px';
                input.style.borderRadius = '3px';

                // 替换文本为输入框
                tabTextEl.innerHTML = '';
                tabTextEl.appendChild(input);
                input.focus();
                input.select();

                // 完成编辑
                const finishEdit = () => {
                    const newTitle = input.value.trim() || currentTitle;
                    updateTabTitle(tab.id, newTitle, true); // 标记为手动重命名
                };

                input.addEventListener('blur', finishEdit);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        finishEdit();
                    } else if (e.key === 'Escape') {
                        renderTabs();
                    }
                });
            });

            // 单击标签切换
            tabElement.addEventListener('click', (e) => {
                if (e.target === tabClose) {
                    e.stopPropagation();
                    deleteTab(tab.id);
                } else {
                    switchToTab(tab.id);
                }
            });

            container.appendChild(tabElement);
        });
    };

    let setupTabBar = () => {
        const addButton = document.querySelector('#add-tab-button');
        addButton.addEventListener('click', () => {
            createTab('', null); // 不提供标题，让它自动从内容提取
        });
    };

    // 本地存储

    let saveTabsState = () => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageKey, {
            tabs: tabs,
            currentTabId: currentTabId
        }, expiredAt);
    };

    let loadTabsState = () => {
        let savedState = Storehouse.getItem(localStorageNamespace, localStorageKey);
        return savedState;
    };

    let loadScrollBarSettings = () => {
        let lastContent = Storehouse.getItem(localStorageNamespace, localStorageScrollBarKey);
        return lastContent;
    };

    let saveScrollBarSettings = (settings) => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageScrollBarKey, settings, expiredAt);
    };

    // 字体大小存储
    let loadFontSizeSettings = () => {
        let savedFontSize = Storehouse.getItem(localStorageNamespace, localStorageFontSizeKey);
        return savedFontSize;
    };

    let saveFontSizeSettings = (fontSize) => {
        let expiredAt = new Date(2099, 1, 1);
        Storehouse.setItem(localStorageNamespace, localStorageFontSizeKey, fontSize, expiredAt);
    };

    // 更新字体大小
    let updateFontSize = (newSize) => {
        currentFontSize = Math.max(minFontSize, Math.min(maxFontSize, newSize));

        // 更新编辑器字体大小
        editor.updateOptions({ fontSize: currentFontSize });

        // 更新预览区域字体大小
        const outputElement = document.querySelector('#output');
        if (outputElement) {
            outputElement.style.fontSize = currentFontSize + 'px';
        }

        // 保存设置
        saveFontSizeSettings(currentFontSize);
    };

    // 设置顶部区域滚轮缩放
    let setupHeaderZoom = () => {
        const header = document.querySelector('header');

        // 顶部区域直接滚轮缩放
        header.addEventListener('wheel', (e) => {
            e.preventDefault();

            // 滚轮向上放大，向下缩小
            const delta = e.deltaY < 0 ? 1 : -1;
            const newSize = currentFontSize + delta;

            updateFontSize(newSize);
        }, { passive: false });

        // 全局 Alt+滚轮 缩放
        document.addEventListener('wheel', (e) => {
            if (e.altKey) {
                e.preventDefault();

                const delta = e.deltaY < 0 ? 1 : -1;
                const newSize = currentFontSize + delta;

                updateFontSize(newSize);
            }
        }, { passive: false });
    };

    // 分割线拖拽
    let setupDivider = () => {
        let lastLeftRatio = 0.5;
        const divider = document.getElementById('split-divider');
        const leftPane = document.getElementById('edit');
        const rightPane = document.getElementById('preview');
        const container = document.getElementById('container');

        let isDragging = false;

        divider.addEventListener('mouseenter', () => {
            divider.classList.add('hover');
        });

        divider.addEventListener('mouseleave', () => {
            if (!isDragging) {
                divider.classList.remove('hover');
            }
        });

        divider.addEventListener('mousedown', () => {
            isDragging = true;
            divider.classList.add('active');
            document.body.style.cursor = 'col-resize';
        });

        divider.addEventListener('dblclick', () => {
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const dividerWidth = divider.offsetWidth;
            const halfWidth = (totalWidth - dividerWidth) / 2;

            leftPane.style.width = halfWidth + 'px';
            rightPane.style.width = halfWidth + 'px';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            document.body.style.userSelect = 'none';
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const offsetX = e.clientX - containerRect.left;
            const dividerWidth = divider.offsetWidth;

            // Prevent overlap or out-of-bounds
            const minWidth = 100;
            const maxWidth = totalWidth - minWidth - dividerWidth;
            const leftWidth = Math.max(minWidth, Math.min(offsetX, maxWidth));
            leftPane.style.width = leftWidth + 'px';
            rightPane.style.width = (totalWidth - leftWidth - dividerWidth) + 'px';
            lastLeftRatio = leftWidth / (totalWidth - dividerWidth);
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                divider.classList.remove('active');
                divider.classList.remove('hover');
                document.body.style.cursor = 'default';
                document.body.style.userSelect = '';
            }
        });

        window.addEventListener('resize', () => {
            const containerRect = container.getBoundingClientRect();
            const totalWidth = containerRect.width;
            const dividerWidth = divider.offsetWidth;
            const availableWidth = totalWidth - dividerWidth;

            const newLeft = availableWidth * lastLeftRatio;
            const newRight = availableWidth * (1 - lastLeftRatio);

            leftPane.style.width = newLeft + 'px';
            rightPane.style.width = newRight + 'px';
        });
    };

    // 入口点
    let editor = setupEditor();

    // 加载保存的标签页状态
    let savedState = loadTabsState();
    if (savedState && savedState.tabs && savedState.tabs.length > 0) {
        tabs = savedState.tabs;
        // 确保所有标签都有 isManuallyRenamed 属性
        tabs.forEach(tab => {
            if (typeof tab.isManuallyRenamed === 'undefined') {
                tab.isManuallyRenamed = false;
            }
        });
        currentTabId = savedState.currentTabId || tabs[0].id;
        renderTabs();
        switchToTab(currentTabId);
    } else {
        // 创建默认标签页
        createTab(defaultInput, 'Welcome');
    }

    setupClearAllButton();
    setupResetButton();
    setupCopyButton(editor);
    setupTabBar();

    let scrollBarSettings = loadScrollBarSettings() || false;
    initScrollBarSync(scrollBarSettings);

    // 加载字体大小设置
    let savedFontSize = loadFontSizeSettings();
    if (savedFontSize) {
        currentFontSize = savedFontSize;
        updateFontSize(currentFontSize);
    }

    // 设置顶部区域滚轮缩放
    setupHeaderZoom();

    // 设置右侧预览滚动监听
    setupPreviewScrollSync();

    setupDivider();
};

window.addEventListener("load", () => {
    init();
});

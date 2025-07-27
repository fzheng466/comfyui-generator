import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// --- Constants and Configuration ---
const EXTENSION_NAME = "comfyui-generator";
const DEFAULT_SETTINGS = {
    enabled: true,
    comfyui_url: "http://127.0.0.1:8188",
    workflow_json: "",
    prompt_placeholder: "%positive%",
    custom_tags: "", // 用户自定义提示词
    generated_images: [] // 添加图片存储数组
};

// 提示词提取正则
const IMAGE_PROMPT_REGEX = /image###\s*(.*?)\s*###/gi;

// WebSocket连接管理
const wsConnections = new Map();

// --- Utility Functions ---

/**
 * @function loadSettings
 * @description 加载插件设置，如果不存在则使用默认设置。
 * 确保所有默认设置都存在于当前设置中。
 */
function loadSettings() {
    console.log(`[${EXTENSION_NAME}] Loading settings...`);

    if (!extension_settings[EXTENSION_NAME]) {
        console.log(`[${EXTENSION_NAME}] No existing settings found, using defaults`);
        extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
        saveSettingsDebounced();
    } else {
        // 确保所有默认设置都存在
        let needsSave = false;
        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (extension_settings[EXTENSION_NAME][key] === undefined) {
                extension_settings[EXTENSION_NAME][key] = value;
                needsSave = true;
            }
        }

        if (needsSave) {
            saveSettingsDebounced();
        }
    }

    console.log(`[${EXTENSION_NAME}] Settings loaded:`, extension_settings[EXTENSION_NAME]);
}

/**
 * @function saveGeneratedImage
 * @description 保存生成的图片信息到持久化存储。
 * @param {object} imageInfo - 包含图片URL、提示词、文件名、位置信息等。
 */
function saveGeneratedImage(imageInfo) {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    }

    // 确保 generated_images 是数组
    if (!Array.isArray(extension_settings[EXTENSION_NAME].generated_images)) {
        extension_settings[EXTENSION_NAME].generated_images = [];
    }

    const imageData = {
        id: imageInfo.id, // 这个ID是生成图片时按钮的ID，用于唯一标识该次生成
        url: imageInfo.url,
        prompt: imageInfo.prompt, // 包含自定义标签的完整提示词
        originalPrompt: imageInfo.originalPrompt || imageInfo.prompt, // 原始提示词
        customTags: imageInfo.customTags || '',
        timestamp: Date.now(),
        filename: imageInfo.filename,
        subfolder: imageInfo.subfolder,
        type: imageInfo.type,
        // 存储用于恢复的按钮定位信息
        buttonId: imageInfo.buttonId, // 存储生成图片时按钮的ID
        messageIndex: imageInfo.messageIndex, // 消息在页面中的索引
        messageId: imageInfo.messageId, // 消息的唯一ID（如果有的话）
        buttonSelector: imageInfo.buttonSelector // 按钮的选择器
    };

    // 添加到数组开头（最新的在前面）
    extension_settings[EXTENSION_NAME].generated_images.unshift(imageData);

    // 限制存储数量（最多保存100张图片信息）
    if (extension_settings[EXTENSION_NAME].generated_images.length > 100) {
        extension_settings[EXTENSION_NAME].generated_images = extension_settings[EXTENSION_NAME].generated_images.slice(0, 100);
    }

    saveSettingsDebounced();
    console.log(`[${EXTENSION_NAME}] Saved image info with position data:`, imageData);
    renderImageHistory(); // 更新图片历史记录显示
}

/**
 * @function deleteImageEntry
 * @description 从存储中删除一张图片记录。
 * @param {string} imageIdToDelete - 要删除的图片记录的ID。
 */
function deleteImageEntry(imageIdToDelete) {
    if (!Array.isArray(extension_settings[EXTENSION_NAME].generated_images)) {
        extension_settings[EXTENSION_NAME].generated_images = [];
    }

    const initialLength = extension_settings[EXTENSION_NAME].generated_images.length;
    extension_settings[EXTENSION_NAME].generated_images = extension_settings[EXTENSION_NAME].generated_images.filter(
        img => img.id !== imageIdToDelete
    );

    if (extension_settings[EXTENSION_NAME].generated_images.length < initialLength) {
        saveSettingsDebounced();
        toastr.success('图片记录已删除');
        renderImageHistory(); // 更新图片历史记录显示
    } else {
        toastr.error('未找到要删除的图片记录');
    }
}

/**
 * @function clearAllGeneratedImages
 * @description 清除所有生成的图片记录。
 */
function clearAllGeneratedImages() {
    // 使用自定义模态框替代confirm
    showCustomConfirm('确定要清除所有生成的图片记录吗？这将删除所有图片的显示，但不会删除ComfyUI服务器上的实际文件。', () => {
        // 清除页面上显示的图片
        $('.comfyui-generated-image').remove();

        // 确保 generated_images 是数组后再清空
        if (!Array.isArray(extension_settings[EXTENSION_NAME].generated_images)) {
            extension_settings[EXTENSION_NAME].generated_images = [];
        } else {
            extension_settings[EXTENSION_NAME].generated_images = [];
        }

        saveSettingsDebounced();
        toastr.success('已清除所有图片记录');
        console.log(`[${EXTENSION_NAME}] Cleared all generated images`);
        renderImageHistory(); // 更新图片历史记录显示
    });
}

/**
 * @function getRequestHeaders
 * @description 获取请求头，尝试包含CSRF token。
 * @returns {object} 请求头对象。
 */
function getRequestHeaders() {
    const headers = {
        'Content-Type': 'application/json'
    };

    // 尝试获取CSRF token
    try {
        const csrfToken = $('meta[name="csrf-token"]').attr('content') ||
                         $('input[name="_token"]').val() ||
                         window.csrf_token;

        if (csrfToken) {
            headers['X-CSRF-TOKEN'] = csrfToken;
        }
    } catch (error) {
        console.log(`[${EXTENSION_NAME}] Could not get CSRF token:`, error);
    }

    return headers;
}

/**
 * @function connectWebSocket
 * @description 连接到ComfyUI的WebSocket服务。
 * @param {string} clientId - 客户端ID。
 * @param {function} onImageGenerated - 图片生成成功后的回调函数。
 * @param {function} onError - 发生错误时的回调函数。
 * @returns {WebSocket|null} WebSocket实例或null。
 */
function connectWebSocket(clientId, onImageGenerated, onError) {
    const settings = extension_settings[EXTENSION_NAME];
    const wsUrl = settings.comfyui_url.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws?clientId=' + clientId;

    console.log(`[${EXTENSION_NAME}] Connecting to WebSocket: ${wsUrl}`);

    try {
        const ws = new WebSocket(wsUrl);
        wsConnections.set(clientId, ws);

        ws.onopen = function() {
            console.log(`[${EXTENSION_NAME}] WebSocket connected for client: ${clientId}`);
        };

        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);

                // 过滤掉不需要的消息类型
                if (data.type === 'crystools.monitor' ||
                    data.type === 'status' ||
                    data.type === 'progress') {
                    return; // 静默处理这些消息
                }

                console.log(`[${EXTENSION_NAME}] WebSocket message:`, data);

                if (data.type === 'executed' && data.data.output && data.data.output.images) {
                    console.log(`[${EXTENSION_NAME}] Images generated:`, data.data.output.images);
                    onImageGenerated(data.data.output.images);
                } else if (data.type === 'execution_error') {
                    console.error(`[${EXTENSION_NAME}] Execution error:`, data.data);
                    onError('生成过程中发生错误: ' + (data.data.exception_message || '未知错误'));
                }
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] WebSocket message parse error:`, error);
            }
        };

        ws.onerror = function(error) {
            console.error(`[${EXTENSION_NAME}] WebSocket error:`, error);
            onError('WebSocket连接错误');
        };

        ws.onclose = function(event) {
            console.log(`[${EXTENSION_NAME}] WebSocket closed for client: ${clientId}`, event);
            wsConnections.delete(clientId);
        };

        return ws;
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to create WebSocket:`, error);
        onError('无法创建WebSocket连接');
        return null;
    }
}

/**
 * @function getGeneratedImage
 * @description 获取生成的图片URL。
 * @param {string} filename - 图片文件名。
 * @param {string} subfolder - 图片子文件夹。
 * @param {string} type - 图片类型（如'output'）。
 * @returns {string} 图片的完整URL。
 */
async function getGeneratedImage(filename, subfolder = '', type = 'output') {
    const settings = extension_settings[EXTENSION_NAME];
    let comfyuiUrl;
    if (subfolder) {
        comfyuiUrl = `${settings.comfyui_url}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
    } else {
        comfyuiUrl = `${settings.comfyui_url}/view?filename=${encodeURIComponent(filename)}&type=${type}`;
    }
    console.log(`[${EXTENSION_NAME}] Getting image from: ${comfyuiUrl}`);
    return comfyuiUrl; // 直接返回URL，因为云服务器通常需要直接访问
}

/**
 * @function displayGeneratedImage
 * @description 在UI上显示生成的图片。
 * @param {string} imageUrl - 图片的URL。
 * @param {jQuery} $button - 关联的jQuery按钮对象。
 * @param {string} prompt - 图片对应的提示词。
 * @param {boolean} isRestored - 是否为恢复操作。
 */
function displayGeneratedImage(imageUrl, $button, prompt = '', isRestored = false) {
    // 获取当前按钮的唯一ID，用于创建图片容器ID
    const currentButtonUniqueId = $button.attr('id') || $button.data('id');
    if (!currentButtonUniqueId) {
        console.error(`[${EXTENSION_NAME}] 无法显示图片: 目标按钮没有ID或data-id属性。`);
        toastr.error('无法显示图片，按钮缺少唯一标识。');
        return;
    }

    console.log(`[${EXTENSION_NAME}] Displaying generated image for button ID: ${currentButtonUniqueId}`);

    const imageContainerId = `comfyui-image-${currentButtonUniqueId}`;
    $(`#${imageContainerId}`).remove(); // 移除该按钮的所有现有图片容器

    const $imageContainer = $(`
        <div id="${imageContainerId}" class="comfyui-generated-image" style="
            margin: 10px 0;
            padding: 10px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            background: rgba(0,0,0,0.1);
        "></div>
    `);

    $button.after($imageContainer); // 将容器插入到按钮后面

    const $img = $(`
        <img style="
            max-width: 100%;
            height: auto;
            border-radius: 6px;
            cursor: pointer;
            display: block;
            margin: 0 auto;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        ">
    `);

    $imageContainer.append($img); // 只显示图片，不显示提示词

    $img.on('load', function() {
        console.log(`[${EXTENSION_NAME}] Image loaded successfully: ${imageUrl}`);
        if (!isRestored) {
            toastr.success('图片显示成功！');
        }
    })
    .on('error', function() {
        console.error(`[${EXTENSION_NAME}] Image failed to load: ${imageUrl}`);
        // 对于云服务器，提供更多的解决方案
        $imageContainer.html(`
            <div style="
                padding: 20px;
                border: 2px dashed #ff6b6b;
                text-align: center;
                color: #ff6b6b;
                border-radius: 8px;
                background: rgba(255,107,107,0.05);
            ">
                <i class="fa-solid fa-exclamation-triangle"></i><br>
                <span style="margin: 5px 0; display: inline-block;">图片显示失败</span><br>
                <small style="color: #999; display: block; margin: 10px 0;">
                    云服务器图片访问可能受限<br>
                    图片已生成成功，请尝试以下方式查看：
                </small>

                <div style="margin: 15px 0;">
                    <button onclick="window.open('${imageUrl}', '_blank')" style="
                        margin: 5px;
                        padding: 8px 16px;
                        background: #007bff;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">新窗口打开</button>

                    <button onclick="
                        // 使用document.execCommand('copy')兼容性更好
                        const el = document.createElement('textarea');
                        el.value = '${imageUrl}';
                        document.body.appendChild(el);
                        el.select();
                        document.execCommand('copy');
                        document.body.removeChild(el);
                        toastr.success('图片链接已复制到剪贴板');
                    " style="
                        margin: 5px;
                        padding: 8px 16px;
                        background: #28a745;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">复制链接</button>

                    <button onclick="
                        const img = document.createElement('img');
                        img.crossOrigin = 'anonymous';
                        img.onload = function() {
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            ctx.drawImage(img, 0, 0);
                            canvas.toBlob(function(blob) {
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'comfyui_image_' + Date.now() + '.png';
                                a.click();
                                URL.revokeObjectURL(url);
                            });
                        };
                        img.src = '${imageUrl}';
                    " style="
                        margin: 5px;
                        padding: 8px 16px;
                        background: #6f42c1;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">尝试下载</button>

                    <button onclick="document.getElementById('${imageContainerId}').remove()" style="
                        margin: 5px;
                        padding: 8px 16px;
                        background: #dc3545;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">删除</button>
                </div>

                <div style="margin-top: 10px; font-size: 11px; color: #666;">
                    提示：云服务器通常需要配置公网访问权限才能正常显示图片
                </div>
            </div>
        `);
    })
    .on('click', function() {
        if (this.complete && this.naturalHeight !== 0) {
            showImageModal(imageUrl);
        }
    });

    // 设置图片源，添加时间戳避免缓存问题
    const imageUrlWithTimestamp = imageUrl + (imageUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    $img.attr('src', imageUrlWithTimestamp);
}

/**
 * @function showImageModal
 * @description 显示图片模态框。
 * @param {string} imageUrl - 要显示的图片URL。
 */
function showImageModal(imageUrl) {
    $('#comfyui-image-modal').remove(); // 移除现有的模态框

    const modalHtml = `
        <div id="comfyui-image-modal" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.9);
            z-index: 10000;
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: pointer;
        ">
            <img src="${imageUrl}" style="
                max-width: 90%;
                max-height: 90%;
                object-fit: contain;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            ">
            <div style="
                position: absolute;
                top: 20px;
                right: 20px;
                color: white;
                font-size: 24px;
                cursor: pointer;
                background: rgba(0,0,0,0.5);
                width: 40px;
                height: 40px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
            " onclick="document.getElementById('comfyui-image-modal').remove()">×</div>
        </div>
    `;

    $('body').append(modalHtml);

    // 点击关闭模态框
    $('#comfyui-image-modal').on('click', function(e) {
        if (e.target === this) {
            $(this).remove();
        }
    });

    // ESC键关闭
    $(document).on('keydown.modal', function(e) {
        if (e.key === 'Escape') {
            $('#comfyui-image-modal').remove();
            $(document).off('keydown.modal');
        }
    });
}

/**
 * @function showCustomConfirm
 * @description 显示自定义确认模态框。
 * @param {string} message - 确认消息。
 * @param {function} onConfirm - 用户点击确认后的回调。
 * @param {function} onCancel - 用户点击取消后的回调。
 */
function showCustomConfirm(message, onConfirm, onCancel = () => {}) {
    $('#custom-confirm-modal').remove(); // 移除现有的模态框

    const modalHtml = `
        <div id="custom-confirm-modal" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 10001;
            display: flex;
            justify-content: center;
            align-items: center;
        ">
            <div style="
                background: #333;
                padding: 25px;
                border-radius: 8px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.5);
                text-align: center;
                color: white;
                max-width: 400px;
                width: 90%;
            ">
                <p style="margin-bottom: 20px; font-size: 16px; line-height: 1.5;">${message}</p>
                <button id="confirm-yes-btn" style="
                    padding: 10px 20px;
                    margin: 0 10px;
                    background: #28a745;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 14px;
                ">确定</button>
                <button id="confirm-no-btn" style="
                    padding: 10px 20px;
                    margin: 0 10px;
                    background: #dc3545;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 14px;
                ">取消</button>
            </div>
        </div>
    `;

    $('body').append(modalHtml);

    $('#confirm-yes-btn').on('click', function() {
        onConfirm();
        $('#custom-confirm-modal').remove();
    });

    $('#confirm-no-btn').on('click', function() {
        onCancel();
        $('#custom-confirm-modal').remove();
    });
}

/**
 * @function validateWorkflowJson
 * @description 验证ComfyUI工作流JSON的格式和内容。
 * @param {string} jsonString - 待验证的JSON字符串。
 * @returns {object} 包含valid状态和error信息的对象。
 */
function validateWorkflowJson(jsonString) {
    let cleanJson = '';

    try {
        if (!jsonString || !jsonString.trim()) {
            return { valid: false, error: '工作流JSON不能为空。请从ComfyUI导出有效的JSON。' };
        }

        cleanJson = jsonString.trim();

        if (cleanJson.charCodeAt(0) === 0xFEFF) {
            cleanJson = cleanJson.slice(1); // 移除BOM
        }

        // 临时替换占位符以进行JSON验证，避免因占位符导致解析失败
        let tempJson = cleanJson;
        const placeholderReplacements = [
            [/%positive%/g, '"temp_positive_placeholder"'],
            [/%negative%/g, '"temp_negative_placeholder"'],
            [/%seed%/g, '12345'],
            [/%width%/g, '512'],
            [/%height%/g, '512'],
            [/%steps%/g, '20'],
            [/%cfg%/g, '7.0'],
            [/%sampler%/g, '"euler"'],
            [/%scheduler%/g, '"normal"'],
            [/\{\{[^}]+\}\}/g, '"temp_placeholder"'], // 匹配 {{ANYTHING}}
            [/\[[^\]]+\]/g, '"temp_placeholder"'],   // 匹配 [ANYTHING]
            [/%[^%\s,}\]]+%/g, '"temp_placeholder"'], // 匹配 %ANYTHING%
        ];

        placeholderReplacements.forEach(([regex, replacement]) => {
            tempJson = tempJson.replace(regex, replacement);
        });

        const parsed = JSON.parse(tempJson);
        console.log(`[${EXTENSION_NAME}] JSON validation successful`);
        return { valid: true, parsed: parsed };

    } catch (error) {
        console.error(`[${EXTENSION_NAME}] JSON validation failed:`, error);

        let errorContext = '';
        if (error.message.includes('position')) {
            try {
                const position = parseInt(error.message.match(/position (\d+)/)?.[1]);
                if (position && cleanJson) {
                    const start = Math.max(0, position - 50);
                    const end = Math.min(cleanJson.length, position + 50);
                    const context = cleanJson.substring(start, end);
                    errorContext = `\n\n错误位置附近的内容:\n"${context}"`;
                }
            } catch (contextError) {
                console.warn(`[${EXTENSION_NAME}] 无法生成错误上下文:`, contextError);
            }
        }

        let errorMsg = `JSON格式错误: ${error.message}${errorContext}`;
        errorMsg += '\n\n常见解决方案:\n';
        errorMsg += '• 检查是否缺少逗号或有多余逗号。\n';
        errorMsg += '• 检查引号是否正确配对（特别是双引号 `"`）。\n';
        errorMsg += '• 检查花括号 `{}` 和方括号 `[]` 是否正确配对。\n';
        errorMsg += '• 避免在JSON中使用未转义的特殊字符。\n';
        errorMsg += '• 建议使用在线JSON验证器（如 JSONLint.com）检查格式。';

        return {
            valid: false,
            error: errorMsg
        };
    }
}

/**
 * @function generateClientId
 * @description 生成唯一的客户端ID。
 * @returns {string} 客户端ID。
 */
function generateClientId() {
    return 'comfyui_generator_' + Math.random().toString(36).substring(2, 15);
}

// --- UI Creation Functions ---

/**
 * @function createUI
 * @description 创建插件的UI按钮。
 */
function createUI() {
    console.log(`[${EXTENSION_NAME}] Creating UI...`);

    const waitForContainer = () => {
        const container = $('#data_bank_wand_container');
        if (container.length === 0) {
            console.log(`[${EXTENSION_NAME}] Container not ready, waiting...`);
            setTimeout(waitForContainer, 500);
            return;
        }

        if ($('#comfyui-generator-button').length > 0) {
            console.log(`[${EXTENSION_NAME}] Button already exists`);
            return;
        }

        const buttonHtml = `
        <div id="comfyui-generator-button" class="list-group-item flex-container flexGap5" title="ComfyUI生图助手">
            <span style="padding-top: 2px;"><i class="fa-solid fa-image"></i></span>
            <span>生图助手</span>
        </div>`;

        container.append(buttonHtml);
        console.log(`[${EXTENSION_NAME}] Button created and added to container`);
    };

    waitForContainer();
}

/**
 * @function renderImageHistory
 * @description 渲染已生成的图片历史记录。
 */
function renderImageHistory() {
    const storedImages = extension_settings[EXTENSION_NAME].generated_images || [];
    const $historyContainer = $('#comfyui-image-history-content');
    $historyContainer.empty(); // 清空现有内容

    if (storedImages.length === 0) {
        $historyContainer.html('<p style="text-align: center; color: #999; font-size: 12px; margin-top: 10px;">暂无图片历史记录。</p>');
        return;
    }

    const imageListHtml = storedImages.map(imageData => `
        <div class="comfyui-history-item" style="
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            padding: 8px;
            background: rgba(255,255,255,0.05);
            border-radius: 6px;
            position: relative;
        ">
            <img src="${imageData.url}" alt="Generated Image" style="
                width: 60px;
                height: 60px;
                object-fit: cover;
                border-radius: 4px;
                margin-right: 10px;
                cursor: pointer;
            " onclick="showImageModal('${imageData.url}')">
            <div style="flex-grow: 1; font-size: 12px; color: #ccc;">
                <div style="font-weight: bold; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${imageData.originalPrompt}">
                    ${imageData.originalPrompt.substring(0, 40)}${imageData.originalPrompt.length > 40 ? '...' : ''}
                </div>
                <div style="color: #aaa;">${new Date(imageData.timestamp).toLocaleString()}</div>
            </div>
            <button class="comfyui-delete-history-btn" data-id="${imageData.id}" style="
                background: none;
                border: none;
                color: #ff6b6b;
                font-size: 16px;
                cursor: pointer;
                padding: 5px;
                margin-left: 10px;
            " title="删除记录">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `).join('');

    $historyContainer.html(imageListHtml);

    // 绑定删除按钮事件
    $historyContainer.find('.comfyui-delete-history-btn').on('click', function() {
        const imageId = $(this).data('id');
        showCustomConfirm('确定要删除这条图片记录吗？', () => deleteImageEntry(imageId));
    });
}

/**
 * @function restoreStoredImages
 * @description 恢复已存储的图片到原始位置。
 */
function restoreStoredImages() {
    console.log(`[${EXTENSION_NAME}] Restoring stored images...`);

    const storedImages = extension_settings[EXTENSION_NAME].generated_images || [];

    if (storedImages.length === 0) {
        toastr.info('没有找到已存储的图片');
        return;
    }

    // 先清除所有现有的图片显示，避免重复
    $('.comfyui-generated-image').remove();

    // 按原始提示词分组，只保留每个提示词的最新图片
    const latestImagesByPrompt = new Map();
    storedImages.forEach(imageData => {
        const promptKey = imageData.originalPrompt || imageData.prompt;
        if (!latestImagesByPrompt.has(promptKey) ||
            imageData.timestamp > latestImagesByPrompt.get(promptKey).timestamp) {
            latestImagesByPrompt.set(promptKey, imageData);
        }
    });

    const imagesToRestore = Array.from(latestImagesByPrompt.values());
    console.log(`[${EXTENSION_NAME}] Found ${imagesToRestore.length} unique prompts to restore`);

    if (imagesToRestore.length === 0) {
        toastr.info('没有找到可恢复的图片');
        return;
    }

    let restoredCount = 0;
    let failedCount = 0;

    imagesToRestore.forEach((imageData, index) => {
        // 尝试找到原始按钮位置
        let $targetButton = null;
        const originalPrompt = imageData.originalPrompt || imageData.prompt;

        // 优先通过存储的 buttonSelector 查找
        if (imageData.buttonSelector) {
            $targetButton = $(imageData.buttonSelector).first();
            if ($targetButton.length > 0) {
                console.log(`[${EXTENSION_NAME}] Found button by selector: ${imageData.buttonSelector}`);
            }
        }

        // 如果没找到，尝试通过消息索引和提示词查找
        if (!$targetButton || $targetButton.length === 0) {
            if (typeof imageData.messageIndex === 'number') {
                const $targetMessage = $('.mes').eq(imageData.messageIndex);
                if ($targetMessage.length > 0) {
                    $targetButton = $targetMessage.find(`.comfyui-generate-btn[data-prompt="${originalPrompt}"]`).first();
                    if ($targetButton.length > 0) {
                        console.log(`[${EXTENSION_NAME}] Found button by message index and prompt: ${imageData.messageIndex}`);
                    }
                }
            }
        }

        // 如果还没找到，通过消息ID和提示词查找
        if (!$targetButton || $targetButton.length === 0) {
            if (imageData.messageId) {
                const $targetMessage = $(`[mesid="${imageData.messageId}"], [id="${imageData.messageId}"]`).first();
                if ($targetMessage.length > 0) {
                    $targetButton = $targetMessage.find(`.comfyui-generate-btn[data-prompt="${originalPrompt}"]`).first();
                    if ($targetButton.length > 0) {
                        console.log(`[${EXTENSION_NAME}] Found button by message ID and prompt: ${imageData.messageId}`);
                    }
                }
            }
        }

        // 最后尝试通过原始提示词全局搜索匹配的按钮
        if (!$targetButton || $targetButton.length === 0) {
            $targetButton = $(`.comfyui-generate-btn[data-prompt="${originalPrompt}"]`).first();
            if ($targetButton.length > 0) {
                console.log(`[${EXTENSION_NAME}] Found button by global prompt search: ${originalPrompt}`);
            }
        }


        if ($targetButton && $targetButton.length > 0) {
            // 延迟恢复，避免同时处理太多请求
            setTimeout(async () => {
                try {
                    console.log(`[${EXTENSION_NAME}] Attempting to restore image for prompt: ${originalPrompt}`);

                    const imageUrl = await getGeneratedImage(imageData.filename, imageData.subfolder, imageData.type);
                    if (imageUrl) {
                        displayGeneratedImage(imageUrl, $targetButton, imageData.prompt, true);
                        restoredCount++;
                        console.log(`[${EXTENSION_NAME}] Successfully restored image: ${imageData.id}`);
                    } else {
                        failedCount++;
                        console.error(`[${EXTENSION_NAME}] Failed to get image URL for: ${imageData.id}`);
                    }
                } catch (error) {
                    failedCount++;
                    console.error(`[${EXTENSION_NAME}] Failed to restore image: ${imageData.id}`, error);
                }
            }, index * 200); // 错开恢复时间，避免同时请求太多
        } else {
            failedCount++;
            console.warn(`[${EXTENSION_NAME}] Could not find button for prompt: "${originalPrompt}" (Stored ID: ${imageData.id}). Skipping restoration for this image.`);
        }
    });

    // --- 关键修复点：将最终的总结消息延迟到所有异步操作完成后触发 ---
    const totalDelay = imagesToRestore.length * 200 + 500; // 确保所有setTimeout都已执行完毕
    setTimeout(() => {
        if (restoredCount > 0) {
            toastr.success(`成功恢复 ${restoredCount} 张图片到原始位置`);
        }
        if (failedCount > 0) {
            toastr.warning(`${failedCount} 张图片无法恢复到原始位置（可能原始按钮已不存在或聊天已重置）`);
        }
        // 只有在没有任何图片被恢复或尝试恢复时才显示此消息
        if (restoredCount === 0 && failedCount === 0 && imagesToRestore.length > 0) {
            toastr.warning('没有找到可恢复的图片位置，可能原始按钮已不存在或聊天已重置。');
        } else if (imagesToRestore.length === 0) {
            // 如果一开始就没有图片要恢复，这个消息已经在函数开头处理了
        }
    }, totalDelay);
}

/**
 * @function addSettingsManagement
 * @description 添加设置管理功能到弹窗。
 */
function addSettingsManagement() {
    // 获取当前用户信息
    let currentUser = 'default-user';
    try {
        if (typeof getContext === 'function') {
            const context = getContext();
            if (context && context.username) {
                currentUser = context.username;
            }
        }
    } catch (error) {
        console.log(`[${EXTENSION_NAME}] Could not get user context, using default`);
    }

    // 确保 generated_images 是数组后再获取长度
    let imageCount = 0;
    if (Array.isArray(extension_settings[EXTENSION_NAME].generated_images)) {
        imageCount = extension_settings[EXTENSION_NAME].generated_images.length;
    } else {
        // 如果不是数组，重新初始化
        extension_settings[EXTENSION_NAME].generated_images = [];
        saveSettingsDebounced();
    }

    // 显示用户信息和管理功能
    const managementHtml = `
        <div style="text-align: center; margin-bottom: 15px;">
            <small style="color: #666; font-size: 11px;">当前用户: ${currentUser}</small><br>
            <small style="color: #666; font-size: 11px;">设置路径: data/${currentUser}/settings.json</small><br>
            <small style="color: #666; font-size: 11px;">已存储图片: <span id="comfyui-image-count">${imageCount}</span> 张</small>
        </div>

        <div style="text-align: center;">
            <button id="comfyui-restore-images-btn" style="
                padding: 6px 12px;
                background: #17a2b8;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                margin: 3px;
                font-size: 11px;
                width: 100%;
                margin-bottom: 5px;
            ">恢复图片显示</button>

            <button id="comfyui-clear-images-btn" style="
                padding: 6px 12px;
                background: #dc3545;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                margin: 3px;
                font-size: 11px;
                width: 100%;
            ">清除所有图片</button>
        </div>
    `;

    $('#comfyui-management-content').html(managementHtml);

    // 绑定按钮事件
    $(document).on('click', '#comfyui-restore-images-btn', restoreStoredImages);
    $(document).on('click', '#comfyui-clear-images-btn', clearAllGeneratedImages);
}

/**
 * @function createPopup
 * @description 创建插件的设置弹窗。
 */
function createPopup() {
    console.log(`[${EXTENSION_NAME}] Creating popup...`);

    $('#comfyui-generator-popup').remove();

    const popupHtml = `
    <div id="comfyui-generator-popup" class="comfyui-generator-popup" style="
        position: fixed;
        top: 50%; /* 垂直居中 */
        left: 50%; /* 水平居中 */
        transform: translate(-50%, -50%); /* 精确居中 */
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.7);
        z-index: 9999; /* 确保它在最上层 */
        display: flex; /* 用于居中内容 */
        justify-content: center;
        align-items: center;
        display: none; /* 默认隐藏 */
    ">
        <div class="comfyui-generator-popup-content" style="
            background: #222;
            padding: 20px;
            border-radius: 10px;
            /* 移除 box-shadow，因为背景已经提供了足够的视觉深度 */
            box-shadow: none; 
            max-width: 800px; /* 调整最大宽度 */
            width: 90%; /* 确保在小屏幕上也能适应 */
            max-height: 90vh; /* 最大高度限制为视口高度的90% */
            overflow-y: auto; /* 内容溢出时显示滚动条 */
            color: #eee;
            position: relative;
        ">
            <div class="comfyui-generator-popup-title">
                <span>ComfyUI生图设置</span>
                <button id="comfyui-generator-popup-close" class="comfyui-generator-close-btn" style="float: right; background: none; border: none; font-size: 18px; cursor: pointer; color: #999;">×</button>
            </div>

            <div class="comfyui-generator-input-section">
                <label class="comfyui-generator-label">ComfyUI地址:</label>
                <input type="text" id="comfyui-url-input" placeholder="http://127.0.0.1:8188" class="comfyui-generator-input">
                <div class="comfyui-generator-hint">
                    ComfyUI服务器的地址，例如：http://127.0.0.1:8188 或您的云服务器地址。
                </div>
            </div>

            <div class="comfyui-generator-input-section">
                <label class="comfyui-generator-label">提示词占位符:</label>
                <input type="text" id="comfyui-placeholder-input" placeholder="%positive%" class="comfyui-generator-input">
                <div class="comfyui-generator-hint">
                    在工作流JSON中用于替换的占位符文本。常见格式：%positive%、{{PROMPT}}、[PROMPT]等。
                </div>
            </div>

            <div class="comfyui-generator-input-section">
                <label class="comfyui-generator-label">自定义提示词标签:</label>
                <input type="text" id="comfyui-custom-tags-input" placeholder="例如：masterpiece, best quality, ultra detailed" class="comfyui-generator-input">
                <div class="comfyui-generator-hint">
                    这些标签会自动添加到每次生图的提示词前面，用逗号分隔多个标签。
                </div>
            </div>

            <!-- 新的两列布局 -->
            <div style="display: flex; gap: 20px; margin-top: 20px; flex-wrap: wrap;">
                <!-- 左侧：设置管理 -->
                <div style="flex: 1; min-width: 280px;">
                    <div class="comfyui-generator-management-container">
                        <div style="text-align: center; margin-bottom: 15px;">
                            <label class="comfyui-generator-label" style="display: block; margin-bottom: 10px;">设置管理</label>
                        </div>
                        <div id="comfyui-management-content">
                            <!-- 设置管理内容将在这里动态插入 -->
                        </div>
                    </div>
                    <div class="comfyui-generator-management-container" style="margin-top: 20px;">
                        <div style="text-align: center; margin-bottom: 15px;">
                            <label class="comfyui-generator-label" style="display: block; margin-bottom: 10px;">已生成图片历史</label>
                        </div>
                        <div id="comfyui-image-history-content" style="max-height: 300px; overflow-y: auto; padding-right: 10px;">
                            <!-- 图片历史记录将在这里动态插入 -->
                        </div>
                    </div>
                </div>

                <!-- 右侧：工作流JSON -->
                <div style="flex: 1; min-width: 280px;">
                    <div class="comfyui-generator-input-section" style="margin: 0;">
                        <label class="comfyui-generator-label">ComfyUI工作流JSON:</label>
                        <textarea id="comfyui-workflow-input" placeholder="粘贴你的ComfyUI工作流JSON..." class="comfyui-generator-textarea" style="height: 350px;"></textarea>
                        <div class="comfyui-generator-hint">
                            从ComfyUI界面导出的工作流JSON，确保其中包含上面设置的占位符。
                        </div>
                    </div>
                </div>
            </div>

            <div class="comfyui-generator-popup-footer">
                <button id="comfyui-save-settings-btn" class="comfyui-generator-btn">保存设置</button>
                <button id="comfyui-test-connection-btn" class="comfyui-generator-btn">测试连接</button>
                <button id="comfyui-generator-popup-close-footer" class="comfyui-generator-close-btn">关闭</button>
            </div>
        </div>
    </div>`;

    $('body').append(popupHtml);

    // Add settings management features to the specified container
    addSettingsManagement();
    // Render image history
    renderImageHistory();

    // Add event for the close button at the bottom
    $(document).on('click', '#comfyui-generator-popup-close-footer', function() {
        $('#comfyui-generator-popup').hide();
    });

    console.log(`[${EXTENSION_NAME}] Popup created with new layout`);
}

/**
 * @function addGenerateButton
 * @description 在消息元素中添加生图按钮。
 * @param {string} prompt - 原始提示词。
 * @param {jQuery} $messageElement - 消息的jQuery对象。
 */
function addGenerateButton(prompt, $messageElement) {
    // 生成唯一的按钮ID
    const buttonId = `comfyui-btn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(`[${EXTENSION_NAME}] Adding generate button with ID: ${buttonId}`);
    console.log(`[${EXTENSION_NAME}] Prompt: ${prompt}`);

    const displayPrompt = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;

    const $button = $(`
        <button class="comfyui-generate-btn"
                data-prompt="${prompt}"
                data-id="${buttonId}"
                id="${buttonId}"
                title="${prompt}"
                style="
                    margin: 5px 0;
                    padding: 8px 12px;
                    background: #28a745;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    display: inline-flex;
                    align-items: center;
                    gap: 5px;
                ">
            <i class="fa-solid fa-image"></i> 生成图像: ${displayPrompt}
        </button>
    `);

    // 绑定点击事件
    $button.on('click', function() {
        const $btn = $(this);
        const originalText = $btn.html();

        // 防止重复点击
        if ($btn.prop('disabled')) {
            return;
        }

        // 更新按钮状态
        $btn.prop('disabled', true)
            .html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...')
            .css('background', '#6c757d');

        // 开始生成图片
        generateImage(prompt, buttonId, $btn)
            .then(() => {
                console.log(`[${EXTENSION_NAME}] Image generation completed for button: ${buttonId}`);
            })
            .catch((error) => {
                console.error(`[${EXTENSION_NAME}] Image generation failed for button ${buttonId}:`, error);
                toastr.error(`图片生成失败: ${error.message}`);
            })
            .finally(() => {
                // 恢复按钮状态
                $btn.prop('disabled', false)
                    .html(originalText)
                    .css('background', '#28a745');
            });
    });

    // 将按钮添加到消息元素
    $messageElement.append($button);

    console.log(`[${EXTENSION_NAME}] Generate button added successfully: ${buttonId}`);
}

// --- Event Listeners and Core Logic ---

/**
 * @function setupEventListeners
 * @description 设置插件的各种事件监听器。
 */
function setupEventListeners() {
    console.log(`[${EXTENSION_NAME}] Setting up event listeners...`);

    // 主按钮点击事件
    $(document).on('click', '#comfyui-generator-button', function() {
        console.log(`[${EXTENSION_NAME}] Generator button clicked`);

        if (!extension_settings[EXTENSION_NAME]?.enabled) {
            toastr.warning('ComfyUI生图助手当前已禁用');
            return;
        }

        // 加载当前设置到输入框
        const settings = extension_settings[EXTENSION_NAME];
        $('#comfyui-url-input').val(settings.comfyui_url || DEFAULT_SETTINGS.comfyui_url);
        $('#comfyui-placeholder-input').val(settings.prompt_placeholder || DEFAULT_SETTINGS.prompt_placeholder);
        $('#comfyui-custom-tags-input').val(settings.custom_tags || DEFAULT_SETTINGS.custom_tags);
        $('#comfyui-workflow-input').val(settings.workflow_json || DEFAULT_SETTINGS.workflow_json);

        // 更新图片计数显示
        $('#comfyui-image-count').text(Array.isArray(settings.generated_images) ? settings.generated_images.length : 0);
        renderImageHistory(); // 重新渲染历史记录

        const $popup = $('#comfyui-generator-popup');
        $popup.show();

        // 聚焦到第一个输入框
        setTimeout(() => {
            $('#comfyui-url-input').focus();
        }, 100);
    });

    // 保存设置按钮点击事件
    $(document).on('click', '#comfyui-save-settings-btn', function() {
        console.log(`[${EXTENSION_NAME}] Saving settings...`);

        const url = $('#comfyui-url-input').val().trim();
        const placeholder = $('#comfyui-placeholder-input').val().trim() || DEFAULT_SETTINGS.prompt_placeholder;
        const customTags = $('#comfyui-custom-tags-input').val().trim();
        const workflowJson = $('#comfyui-workflow-input').val().trim();

        if (!url) {
            toastr.error('请输入ComfyUI地址。');
            return;
        }

        if (workflowJson) {
            const validation = validateWorkflowJson(workflowJson);
            if (!validation.valid) {
                console.warn(`[${EXTENSION_NAME}] JSON validation failed:`, validation.error);

                // 使用自定义模态框替代confirm
                showCustomConfirm(`工作流JSON验证失败:\n\n${validation.error}\n\n是否强制保存设置？\n\n点击"确定"强制保存，点击"取消"返回修改。`,
                    () => { // 确认回调
                        console.log(`[${EXTENSION_NAME}] User confirmed force save`);
                        saveSettingsProceed(url, placeholder, customTags, workflowJson);
                        toastr.warning('已强制保存设置，跳过JSON验证。');
                    },
                    () => { // 取消回调
                        console.log(`[${EXTENSION_NAME}] User cancelled force save`);
                    }
                );
                return; // 等待用户确认
            } else {
                if (!workflowJson.includes(placeholder)) {
                    // 使用自定义模态框替代confirm
                    showCustomConfirm(`工作流中未找到占位符 "${placeholder}"。\n\n这可能导致生图时提示词无法正确替换。\n\n是否仍要保存设置？`,
                        () => { // 确认回调
                            saveSettingsProceed(url, placeholder, customTags, workflowJson);
                        }
                    );
                    return; // 等待用户确认
                } else {
                    console.log(`[${EXTENSION_NAME}] Placeholder "${placeholder}" found in workflow`);
                    const matches = workflowJson.match(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
                    const count = matches ? matches.length : 0;
                    console.log(`[${EXTENSION_NAME}] Placeholder appears ${count} times在工作流中，生图时将全部替换。`);
                    if (count > 1) {
                        toastr.info(`占位符 "${placeholder}" 在工作流中出现 ${count} 次，生图时将全部替换。`);
                    }
                }
            }
        } else {
            toastr.warning('未配置工作流JSON，请添加工作流后再测试生图功能。');
        }

        // 如果上述验证都通过，直接保存
        saveSettingsProceed(url, placeholder, customTags, workflowJson);
    });

    // 弹窗顶部关闭按钮
    $(document).on('click', '#comfyui-generator-popup-close', function() {
        $('#comfyui-generator-popup').hide();
    });

    // 测试连接按钮
    $(document).on('click', '#comfyui-test-connection-btn', testConnection);

    // 插件启用/禁用切换
    $(document).on('change', '#comfyui-generator-toggle', function() {
        const isEnabled = $(this).val() === 'enabled';
        console.log(`[${EXTENSION_NAME}] Plugin toggled: ${isEnabled}`);

        extension_settings[EXTENSION_NAME].enabled = isEnabled;
        saveSettingsDebounced();

        if (isEnabled) {
            toastr.success('ComfyUI生图助手已启用。');
            setTimeout(replaceImagePrompts, 100);
        } else {
            toastr.warning('Comfyui生图助手已禁用。');
        }
    });

    // 监听消息事件，在消息接收、聊天改变、消息发送后替换提示词
    if (typeof eventSource !== 'undefined' && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            setTimeout(replaceImagePrompts, 100);
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(replaceImagePrompts, 100);
        });

        eventSource.on(event_types.MESSAGE_SENT, () => {
            setTimeout(replaceImagePrompts, 100);
        });
    }
}

/**
 * @function saveSettingsProceed
 * @description 实际执行保存设置的逻辑。
 * @param {string} url - ComfyUI URL。
 * @param {string} placeholder - 提示词占位符。
 * @param {string} customTags - 自定义提示词标签。
 * @param {string} workflowJson - 工作流JSON。
 */
function saveSettingsProceed(url, placeholder, customTags, workflowJson) {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }

    extension_settings[EXTENSION_NAME].comfyui_url = url;
    extension_settings[EXTENSION_NAME].prompt_placeholder = placeholder;
    extension_settings[EXTENSION_NAME].custom_tags = customTags;
    extension_settings[EXTENSION_NAME].workflow_json = workflowJson;

    console.log(`[${EXTENSION_NAME}] Settings before save:`, extension_settings[EXTENSION_NAME]);

    saveSettingsDebounced();

    setTimeout(() => {
        console.log(`[${EXTENSION_NAME}] Settings after save:`, extension_settings[EXTENSION_NAME]);
        toastr.success('设置已保存并持久化。');
    }, 100);

    $('#comfyui-generator-popup').hide();
    console.log(`[${EXTENSION_NAME}] Settings saved successfully`);
}

/**
 * @function replaceImagePrompts
 * @description 替换消息中的image###块为生图按钮。
 */
function replaceImagePrompts() {
    if (!extension_settings[EXTENSION_NAME]?.enabled) {
        return;
    }

    $('.mes').each(function() {
        const $message = $(this);
        const $mesText = $message.find('.mes_text');
        const messageText = $mesText.html();

        // 检查是否已经处理过，或者没有文本内容
        if (!messageText || $mesText.hasClass('comfyui-processed')) {
            return;
        }

        let hasMatch = false;
        const updatedText = messageText.replace(IMAGE_PROMPT_REGEX, function(match, prompt) {
            hasMatch = true;
            const trimmedPrompt = prompt.trim();
            // 为每个生成的按钮提供一个唯一的ID，以便后续关联图片
            const buttonId = `comfyui-btn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const displayPrompt = trimmedPrompt.length > 30 ? trimmedPrompt.substring(0, 30) + '...' : trimmedPrompt;

            return `<button class="comfyui-generate-btn" data-prompt="${trimmedPrompt}" data-id="${buttonId}" id="${buttonId}" title="${trimmedPrompt}" style="
                        margin: 5px 0;
                        padding: 8px 12px;
                        background: #28a745;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                    ">
                        <i class="fa-solid fa-image"></i> 生成图像: ${displayPrompt}
                    </button>`;
        });

        if (hasMatch) {
            $mesText.html(updatedText);
            $mesText.addClass('comfyui-processed'); // 标记为已处理
        }
    });

    // 重新绑定点击事件，确保新添加的按钮也能响应
    // 使用事件委托，只绑定一次到document，效率更高
    $(document).off('click', '.comfyui-generate-btn').on('click', '.comfyui-generate-btn', function() {
        const prompt = $(this).data('prompt');
        const buttonId = $(this).data('id'); // 获取当前按钮的实时ID
        generateImage(prompt, buttonId, $(this));
    });
}

/**
 * @function testConnection
 * @description 测试与ComfyUI服务器的连接。
 */
async function testConnection() {
    const url = $('#comfyui-url-input').val();
    if (!url) {
        toastr.error('请输入ComfyUI地址。');
        return;
    }

    const $btn = $('#comfyui-test-connection-btn');
    const originalText = $btn.text();
    $btn.text('测试中...').prop('disabled', true);

    try {
        console.log(`[${EXTENSION_NAME}] Testing connection to: ${url}`);

        // 使用 fetch API 进行连接测试，由于跨域限制，通常只能判断是否能访问到服务器
        const response = await fetch(`${url}/system_stats`, {
            method: 'GET',
            mode: 'no-cors' // 允许跨域请求，但无法读取响应内容
        });

        console.log(`[${EXTENSION_NAME}] Connection test completed (no-cors mode)`);
        toastr.success('ComfyUI连接测试完成 (无法验证详细状态，但连接正常)。');

    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Connection test failed:`, error);

        const errorHtml = `
            <div style="text-align: left;">
                <strong>连接失败</strong><br><br>
                <strong>可能的解决方案：</strong><br>
                1. 确保ComfyUI正在运行。<br>
                2. 检查ComfyUI地址是否正确（例如：` + (url.startsWith('http') ? url : 'http://' + url) + `）。<br>
                3. 确认云服务器端口已开放（例如：8188）。<br>
                4. 检查防火墙设置是否阻止了连接。<br>
                5. 如果是云服务器，确保ComfyUI配置了公网访问。
            </div>
        `;

        toastr.error(errorHtml, 'ComfyUI连接失败', {
            timeOut: 10000,
            allowHtml: true
        });
    } finally {
        $btn.text(originalText).prop('disabled', false);
    }
}

/**
 * @function generateImage
 * @description 发送请求到ComfyUI生成图片。
 * @param {string} prompt - 原始提示词。
 * @param {string} buttonId - 触发生成操作的按钮ID。
 * @param {jQuery} $button - 触发生成操作的jQuery按钮对象。
 */
async function generateImage(prompt, buttonId, $button) {
    console.log(`[${EXTENSION_NAME}] Generating image for prompt: ${prompt}`);

    const settings = extension_settings[EXTENSION_NAME];

    if (!settings.comfyui_url || !settings.workflow_json) {
        toastr.error('请先在设置中配置ComfyUI地址和工作流。');
        $button.prop('disabled', false).html($button.data('original-html'));
        return;
    }

    // 处理自定义标签：简单地添加到原始提示词前面
    let finalPrompt = prompt;
    if (settings.custom_tags && settings.custom_tags.trim()) {
        const customTags = settings.custom_tags.trim();
        finalPrompt = `${customTags}, ${prompt}`;
        console.log(`[${EXTENSION_NAME}] Added custom tags. Final prompt: ${finalPrompt}`);
    }

    // 保存按钮的位置信息，用于图片恢复
    const $messageElement = $button.closest('.mes');
    const messageIndex = $('.mes').index($messageElement);
    const messageId = $messageElement.attr('mesid') || $messageElement.attr('id') || '';

    // 生成按钮选择器，优先使用ID
    let buttonSelector = '';
    if ($button.attr('id')) {
        buttonSelector = `#${$button.attr('id')}`;
    } else if ($button.attr('data-id')) {
        buttonSelector = `[data-id="${$button.attr('data-id')}"]`;
    } else {
        // Fallback to a more complex selector if no unique ID is present
        buttonSelector = `.comfyui-generate-btn[data-prompt="${prompt.replace(/"/g, '\\"')}"]`;
    }

    console.log(`[${EXTENSION_NAME}] Button position info - messageIndex: ${messageIndex}, messageId: ${messageId}, selector: ${buttonSelector}`);

    const originalButtonHtml = $button.html(); // 保存原始HTML以便恢复
    $button.data('original-html', originalButtonHtml); // 存储原始HTML
    $button.html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...').prop('disabled', true);

    try {
        let workflowJson = settings.workflow_json.trim();

        if (workflowJson.charCodeAt(0) === 0xFEFF) {
            workflowJson = workflowJson.slice(1); // 移除BOM
        }

        if (!workflowJson) {
            throw new Error('工作流JSON为空，请先配置工作流。');
        }

        console.log(`[${EXTENSION_NAME}] Original workflow JSON length: ${workflowJson.length}`);

        let workflow;
        try {
            workflow = JSON.parse(workflowJson);
        } catch (parseError) {
            console.error(`[${EXTENSION_NAME}] JSON parse error:`, parseError);
            throw new Error(`工作流JSON格式错误: ${parseError.message}。请检查您的工作流JSON。`);
        }

        if (!workflow || typeof workflow !== 'object') {
            throw new Error('工作流JSON必须是一个有效的对象。');
        }

        console.log(`[${EXTENSION_NAME}] Workflow parsed successfully, keys:`, Object.keys(workflow));

        const placeholder = settings.prompt_placeholder || DEFAULT_SETTINGS.prompt_placeholder;
        console.log(`[${EXTENSION_NAME}] Using placeholder: "${placeholder}"`);
        console.log(`[${EXTENSION_NAME}] Final prompt to replace: "${finalPrompt}"`);

        // 每次都生成新的随机种子
        const randomSeed = Math.floor(Math.random() * 4294967296);
        console.log(`[${EXTENSION_NAME}] Generated new random seed: ${randomSeed}`);

        // 递归函数来安全替换对象中的占位符
        function replaceInObject(obj, placeholderToReplace, replacementValue) {
            if (typeof obj === 'string') {
                // 使用正则表达式进行全局替换
                return obj.replace(new RegExp(placeholderToReplace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacementValue);
            } else if (Array.isArray(obj)) {
                return obj.map(item => replaceInObject(item, placeholderToReplace, replacementValue));
            } else if (obj && typeof obj === 'object') {
                const newObj = {};
                for (const [key, value] of Object.entries(obj)) {
                    newObj[key] = replaceInObject(value, placeholderToReplace, replacementValue);
                }
                return newObj;
            }
            return obj;
        }

        // 执行安全替换：使用包含自定义标签的最终提示词
        workflow = replaceInObject(workflow, placeholder, finalPrompt);
        workflow = replaceInObject(workflow, '%seed%', randomSeed.toString()); // 替换种子占位符

        console.log(`[${EXTENSION_NAME}] Safe replacement completed with seed: ${randomSeed}`);

        // 验证替换后的工作流
        try {
            const testSerialization = JSON.stringify(workflow);
            console.log(`[${EXTENSION_NAME}] Workflow validation successful, final length: ${testSerialization.length}`);
        } catch (serializeError) {
            console.error(`[${EXTENSION_NAME}] Error serializing workflow after replacement:`, serializeError);
            throw new Error('替换提示词后工作流序列化失败。请检查工作流JSON结构。');
        }

        // 生成客户端ID
        const clientId = generateClientId();

        // 设置WebSocket监听
        const ws = connectWebSocket(clientId,
            async (images) => { // onImageGenerated callback
                console.log(`[${EXTENSION_NAME}] Processing generated images:`, images);

                try {
                    if (images && images.length > 0) {
                        const imageInfo = images[0]; // 通常只处理第一张图片
                        const imageUrl = await getGeneratedImage(imageInfo.filename, imageInfo.subfolder, imageInfo.type);

                        if (imageUrl) {
                            // 保存图片信息到持久化存储，包含位置信息
                            saveGeneratedImage({
                                id: buttonId, // 存储当前按钮的ID
                                url: imageUrl,
                                prompt: finalPrompt, // 保存包含自定义标签的完整提示词
                                originalPrompt: prompt, // 保存原始提示词
                                customTags: settings.custom_tags || '', // 保存使用的自定义标签
                                filename: imageInfo.filename,
                                subfolder: imageInfo.subfolder,
                                type: imageInfo.type,
                                // 位置信息
                                buttonId: buttonId, // 存储当前按钮的ID
                                messageIndex: messageIndex,
                                messageId: messageId,
                                buttonSelector: buttonSelector
                            });

                            // **关键修复点：将当前按钮对象 $button 直接传递给 displayGeneratedImage**
                            displayGeneratedImage(imageUrl, $button, finalPrompt);
                            toastr.success('图像生成完成！');
                        } else {
                            throw new Error('无法获取生成的图片URL。');
                        }
                    } else {
                        throw new Error('ComfyUI没有返回任何图片。');
                    }
                } catch (error) {
                    console.error(`[${EXTENSION_NAME}] Error processing generated images:`, error);
                    toastr.error('图片生成完成但获取失败: ' + error.message);
                } finally {
                    $button.html(originalButtonHtml).prop('disabled', false); // 恢复按钮状态
                }
            },
            (error) => { // onError callback
                console.error(`[${EXTENSION_NAME}] WebSocket error during generation:`, error);
                $button.html(originalButtonHtml).prop('disabled', false); // 恢复按钮状态
                toastr.error('生成过程中发生错误: ' + error);
            }
        );

        if (!ws) {
            throw new Error('无法建立WebSocket连接。请检查ComfyUI是否正常运行。');
        }

        // 构建请求
        const requestBody = {
            prompt: workflow,
            client_id: clientId
        };

        console.log(`[${EXTENSION_NAME}] Sending request to ComfyUI with seed: ${randomSeed}...`);

        const response = await fetch(`${settings.comfyui_url}/prompt`, {
            method: 'POST',
            mode: 'no-cors', // 允许跨域请求
            headers: {
                'Content-Type': 'application/json',
                ...getRequestHeaders() // 添加CSRF token
            },
            body: JSON.stringify(requestBody)
        });

        console.log(`[${EXTENSION_NAME}] Prompt request sent successfully`);

        toastr.success('图像生成请求已发送，等待生成完成...');

    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Generate image failed:`, error);

        let errorMessage = '图像生成失败: ';
        if (error.message.includes('JSON') || error.message.includes('序列化')) {
            errorMessage += '工作流处理错误，可能是提示词包含特殊字符或JSON结构不正确。';
        } else if (error.message.includes('fetch') || error.message.includes('网络')) {
            errorMessage += '网络连接失败，请检查ComfyUI地址和网络设置。';
        } else if (error.message.includes('占位符')) {
            errorMessage += '占位符配置错误，请检查设置中的占位符是否与工作流JSON匹配。';
        } else if (error.message.includes('WebSocket')) {
            errorMessage += '无法建立实时连接，请检查ComfyUI是否正常运行。';
        } else {
            errorMessage += error.message;
        }

        toastr.error(errorMessage, '生成失败', {
            timeOut: 8000
        });

        $button.html(originalButtonHtml).prop('disabled', false); // 恢复按钮状态
    }
}

// --- Initialization ---

/**
 * @function initializePlugin
 * @description 插件初始化函数。
 */
const initializePlugin = () => {
    console.log(`[${EXTENSION_NAME}] Running initialization...`);

    loadSettings();
    createUI();
    createPopup();
    setupEventListeners();

    setTimeout(() => {
        // 设置UI状态
        $('#comfyui-generator-toggle').val(extension_settings[EXTENSION_NAME]?.enabled ? 'enabled' : 'disabled');

        // 验证设置是否正确加载
        console.log(`[${EXTENSION_NAME}] Loaded settings on startup:`, extension_settings[EXTENSION_NAME]);

        if (extension_settings[EXTENSION_NAME]?.enabled) {
            replaceImagePrompts();
        }
    }, 100);

    console.log(`[${EXTENSION_NAME}] Plugin initialized successfully`);
};

// 等待页面完全加载再初始化插件
jQuery(async () => {
    console.log(`[${EXTENSION_NAME}] Initializing plugin...`);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePlugin);
    } else {
        initializePlugin();
    }
});

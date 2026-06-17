import {
    chat,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    messageFormatting,
    saveChatConditional,
    setExtensionPrompt,
} from '../../../../script.js';

const PROMPT_KEY = 'phone-notification-prompt';
const METADATA_KEY = 'phone_notification_enabled';
const VALID_APPS = new Set(['sms', 'iMessage', 'instagram', 'WhatsApp']);
const MARKER_SELECTOR = 'span[data-phone-notification="true"], span[data-phone-notification="1"], span[data-phone-notification]';
const ESCAPED_MARKER_REGEX = /<span\b([^>]*\bdata-phone-notification(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*)>([\s\S]*?)<\/span>/gi;

const PROMPT = `<phone-notification-format>
When someone sends {{user}} a text message, DM, or phone message inside the story, wrap only the visible message content in this exact HTML span:

<span data-phone-notification="true" data-phone-app="sms" data-phone-sender="name shown on {{user}}'s phone" data-phone-time="HH:MM">message content</span>

Rules:
- Use this span only when someone sends {{user}} a phone notification, text, DM, or message.
- Output the span as real inline HTML, not inside a Markdown code block.
- The visible text between the opening and closing span tags must be the actual incoming message content.
- Do not put the message content in a data attribute.
- data-phone-app must be exactly one of: sms, iMessage, instagram, WhatsApp.
- For sms and iMessage, data-phone-sender is the contact name saved on {{user}}'s phone. If the saved contact name is unknown, use the natural display name {{user}} would recognize.
- For instagram, data-phone-sender is the character's own Instagram display name or username, not {{user}}'s phone contact name.
- For WhatsApp, data-phone-sender is the WhatsApp profile/contact display name visible to {{user}}.
- Keep the span natural inside the prose so the message remains readable even without special styling.
- Escape quotation marks inside data attributes as &quot;.
- Do not use bracketed phone-message blocks or labels.
</phone-notification-format>`;

let enabled = false;
let observer = null;
let toastTimer = null;
const observedBubbles = new WeakSet();
const styleVersion = Date.now();

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function normalizeApp(value) {
    const raw = String(value ?? '').trim();
    const found = [...VALID_APPS].find((app) => app.toLowerCase() === raw.toLowerCase());
    return found ?? 'sms';
}

function getIcon(app) {
    switch (app) {
        case 'instagram': return 'fa-brands fa-instagram';
        case 'WhatsApp': return 'fa-brands fa-whatsapp';
        case 'iMessage': return 'fa-solid fa-comment';
        default: return 'fa-solid fa-message';
    }
}

function appLabel(app) {
    return app === 'sms' ? 'Messages' : app;
}

function dataFromMarker(marker) {
    return {
        app: normalizeApp(marker.dataset.phoneApp),
        sender: String(marker.dataset.phoneSender || 'Unknown').trim(),
        time: String(marker.dataset.phoneTime || '').trim(),
        text: marker.textContent.trim(),
    };
}

function dataFromAttributeString(attributeString, text) {
    const template = document.createElement('template');
    template.innerHTML = `<span ${attributeString}></span>`;
    const marker = template.content.querySelector('span');

    return {
        app: normalizeApp(marker?.dataset.phoneApp),
        sender: String(marker?.dataset.phoneSender || 'Unknown').trim(),
        time: String(marker?.dataset.phoneTime || '').trim(),
        text: decodeHtmlText(text).trim(),
    };
}

function decodeHtmlText(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value ?? '');
    return textarea.value;
}

function createBubble(data, messageId, index) {
    const root = document.createElement('span');
    root.className = 'phone-message-chat';
    root.dataset.phoneMessage = 'true';
    root.dataset.phoneMessageId = `${messageId}-${index}`;
    root.dataset.phoneApp = data.app;
    root.dataset.phoneSender = data.sender;
    root.dataset.phoneTime = data.time;
    root.dataset.phoneText = data.text;
    root.role = 'button';
    root.tabIndex = 0;
    root.title = '알림 다시 보기';

    const bubble = document.createElement('span');
    bubble.className = 'phone-message-bubble';

    const text = document.createElement('span');
    text.className = 'phone-message-text';
    text.innerText = data.text;
    bubble.appendChild(text);

    if (data.time) {
        const time = document.createElement('span');
        time.className = 'phone-message-time';
        time.textContent = data.time;
        bubble.appendChild(time);
    }

    root.appendChild(bubble);
    return root;
}

function enhancePhoneMarkers(root, messageId) {
    const markers = [...root.querySelectorAll(MARKER_SELECTOR)];
    let enhancedCount = 0;

    markers.forEach((marker, index) => {
        const data = dataFromMarker(marker);

        if (!data.text) {
            marker.remove();
            return;
        }

        marker.replaceWith(createBubble(data, messageId, index));
        enhancedCount++;
    });

    enhancedCount += enhanceEscapedPhoneMarkers(root, messageId, enhancedCount);

    return enhancedCount > 0;
}

function enhanceEscapedPhoneMarkers(root, messageId, startIndex) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeValue?.includes('data-phone-notification')) {
            nodes.push(node);
        }
    }

    let count = 0;

    for (const node of nodes) {
        ESCAPED_MARKER_REGEX.lastIndex = 0;
        const text = node.nodeValue || '';

        if (!ESCAPED_MARKER_REGEX.test(text)) {
            continue;
        }

        ESCAPED_MARKER_REGEX.lastIndex = 0;
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = ESCAPED_MARKER_REGEX.exec(text)) !== null) {
            if (match.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const data = dataFromAttributeString(match[1], match[2]);
            if (data.text) {
                fragment.appendChild(createBubble(data, messageId, startIndex + count));
                count++;
            }

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        node.replaceWith(fragment);
    }

    return count;
}

function ensureToastHost() {
    let host = document.getElementById('phone-notification-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'phone-notification-host';
        document.body.appendChild(host);
    }
    return host;
}

function showNotification(data) {
    const host = ensureToastHost();
    host.replaceChildren();

    const toast = document.createElement('div');
    toast.className = `phone-notification-toast phone-notification-${data.app.toLowerCase()}`;
    toast.innerHTML = `
        <div class="phone-notification-icon" aria-hidden="true"><i class="${getIcon(data.app)}"></i></div>
        <div class="phone-notification-content">
            <div class="phone-notification-top">
                <span class="phone-notification-app">${escapeHtml(appLabel(data.app))}</span>
                <span class="phone-notification-now">now</span>
            </div>
            <div class="phone-notification-clamp">
              <div class="phone-notification-sender">${escapeHtml(data.sender)}</div>
              <div class="phone-notification-text">${escapeHtml(data.text)}</div>
            </div>
        </div>
    `;

    host.appendChild(toast);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.classList.add('phone-notification-hide');
        window.setTimeout(() => toast.remove(), 260);
    }, 3000);
}

function dataFromBubble(bubble) {
    return {
        app: normalizeApp(bubble.dataset.phoneApp),
        sender: bubble.dataset.phoneSender || 'Unknown',
        time: bubble.dataset.phoneTime || '',
        text: bubble.dataset.phoneText || '',
    };
}

function markAndNotify(bubble) {
    if (!enabled || bubble.dataset.phoneNotified === 'true') {
        return;
    }

    bubble.dataset.phoneNotified = 'true';
    showNotification(dataFromBubble(bubble));
}

function replayNotification(bubble) {
    if (!enabled) {
        return;
    }

    showNotification(dataFromBubble(bubble));
}

function attachBubbleInteractions(bubble) {
    if (bubble.dataset.phoneClickBound === 'true') {
        return;
    }

    bubble.dataset.phoneClickBound = 'true';
    bubble.addEventListener('click', () => replayNotification(bubble));
    bubble.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        replayNotification(bubble);
    });
}

function getObserver() {
    if (observer) {
        return observer;
    }

    observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                markAndNotify(entry.target);
                observer.unobserve(entry.target);
            }
        }
    }, { threshold: 0.55 });

    return observer;
}

function observeBubbles(root) {
    const bubbles = root.querySelectorAll?.('[data-phone-message="true"]') ?? [];
    for (const bubble of bubbles) {
        attachBubbleInteractions(bubble);

        if (observedBubbles.has(bubble)) {
            continue;
        }
        observedBubbles.add(bubble);
        getObserver().observe(bubble);
    }
}

function sourceHasNewMarker(message) {
    return /data-phone-notification/i.test(String(message?.mes ?? ''));
}

function rerenderSourceMessage(message, textElement, element, messageId) {
    textElement.innerHTML = messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId, {}, false);
    delete element.dataset.phoneNotificationProcessed;
}

function renderMessage(messageId) {
    const message = chat[messageId];
    const element = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    const textElement = element?.querySelector('.mes_text');

    if (!enabled || !message || !textElement || message.is_user) {
        return;
    }

    if (element.dataset.phoneNotificationProcessed === 'true' && !sourceHasNewMarker(message)) {
        rerenderSourceMessage(message, textElement, element, messageId);
        return;
    }

    if (enhancePhoneMarkers(textElement, messageId)) {
        element.dataset.phoneNotificationProcessed = 'true';
    }

    observeBubbles(textElement);
}

function scanRenderedMessages() {
    if (!enabled) {
        return;
    }

    for (let i = 0; i < chat.length; i++) {
        renderMessage(i);
    }
}

function restoreRenderedMessages() {
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        const element = document.querySelector(`#chat .mes[mesid="${i}"]`);
        const textElement = element?.querySelector('.mes_text');

        if (!message || !textElement || element?.dataset.phoneNotificationProcessed !== 'true') {
            continue;
        }

        textElement.innerHTML = messageFormatting(message.mes, message.name, message.is_system, message.is_user, i, {}, false);
        delete element.dataset.phoneNotificationProcessed;
    }
}

function updatePrompt() {
    setExtensionPrompt(
        PROMPT_KEY,
        enabled ? PROMPT : '',
        extension_prompt_types.IN_CHAT,
        2,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function ensureDynamicStyle() {
    const id = 'phone-notification-dynamic-style';
    const existing = document.getElementById(id);
    if (existing) {
        existing.remove();
    }

    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = new URL(`style.css?v=${styleVersion}`, import.meta.url).href;
    document.head.appendChild(link);
}

async function setEnabled(value, persist = true) {
    enabled = Boolean(value);
    chat_metadata[METADATA_KEY] = enabled;
    updatePrompt();
    updateButton();

    if (enabled) {
        scanRenderedMessages();
        toastr.info('폰 알림을 활성화했습니다.');
    } else {
        restoreRenderedMessages();
        toastr.info('폰 알림을 비활성화했습니다.');
    }

    if (persist) {
        await saveChatConditional();
    }
}

function updateButton() {
    const button = document.getElementById('phoneNotificationToggle');
    if (!button) {
        return;
    }

    button.classList.toggle('phone-notification-enabled', enabled);
    button.title = enabled ? '폰 알림 끄기' : '폰 알림 켜기';
    const text = button.querySelector('span');
    if (text) {
        text.textContent = enabled ? '폰 알림 켜짐' : '폰 알림';
    }
}

function addWandButton() {
    if (document.getElementById('phoneNotificationToggle')) {
        updateButton();
        return;
    }

    const container = document.getElementById('extensionsMenu');
    if (!container) {
        window.setTimeout(addWandButton, 500);
        return;
    }

    const button = document.createElement('div');
    button.id = 'phoneNotificationToggle';
    button.className = 'list-group-item flex-container flexGap5 interactable';
    button.tabIndex = 0;
    button.innerHTML = '<i class="fa-solid fa-mobile-screen-button"></i><span>폰 알림</span>';
    button.addEventListener('click', () => setEnabled(!enabled));
    container.appendChild(button);
    updateButton();
}

function loadChatState() {
    enabled = Boolean(chat_metadata?.[METADATA_KEY]);
    updatePrompt();
    updateButton();
    window.setTimeout(scanRenderedMessages, 250);
}

eventSource.on(event_types.APP_READY, () => {
    ensureDynamicStyle();
    addWandButton();
    loadChatState();
});

eventSource.on(event_types.CHAT_CHANGED, () => {
    loadChatState();
});

eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
    window.setTimeout(() => renderMessage(messageId), 50);
});

eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => {
    window.setTimeout(() => renderMessage(messageId), 50);
});

eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
    window.setTimeout(() => renderMessage(messageId), 50);
});

eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
    window.setTimeout(scanRenderedMessages, 100);
});

jQuery(() => {
    ensureDynamicStyle();
    addWandButton();
    loadChatState();
});

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Send,
    Bot,
    User,
    StopCircle,
    Eraser,
    AlertCircle,
    Loader2,
    Paperclip,
    X,
    File as FileIcon,
    Copy,
    Check,
    Plus,
    MessageCircle,
    Trash2,
    ChevronDown,
    PanelLeftClose,
    PanelLeft,
    Sparkles
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '../stores/useConfigStore';
import { useProxyModels } from '../hooks/useProxyModels';
import { cn } from '../utils/cn';
import { showToast } from '../components/common/ToastContainer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[];
    timestamp: number;
    status?: 'sending' | 'streaming' | 'completed' | 'error';
    error?: string;
}

interface Attachment {
    id: string;
    type: 'image' | 'file';
    content: string;
    name: string;
    mimeType?: string;
}

interface Conversation {
    id: string;
    title: string;
    messages: Message[];
    model: string;
    createdAt: number;
    updatedAt: number;
}

interface ProxyStatus {
    running: boolean;
    port: number;
    base_url: string;
    active_accounts: number;
}

// ─── Quick suggestion chips ──────────────────────────────────────────────────

const SUGGESTIONS = [
    { icon: '💡', text: 'Explain how API proxies work' },
    { icon: '✍️', text: 'Write a Python script to call Gemini API' },
    { icon: '🎨', text: 'Generate a futuristic city image' },
    { icon: '📊', text: 'Compare Gemini vs Claude models' },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export default function ChatView() {
    const { t } = useTranslation();
    const { config } = useConfigStore();
    const { models } = useProxyModels();

    // ─── Conversations state ─────────────────────────────────────────────────
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConvId, setActiveConvId] = useState<string | null>(null);
    const [sidebarOpen, setSidebarOpen] = useState(true);

    // ─── Chat state ──────────────────────────────────────────────────────────
    const [input, setInput] = useState('');
    const [selectedModel, setSelectedModel] = useState('gemini-3-pro-image-16-9');
    const [isLoading, setIsLoading] = useState(false);
    const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
    const [isCheckingProxy, setIsCheckingProxy] = useState(true);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [isDragOver, setIsDragOver] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

    // ─── Refs ────────────────────────────────────────────────────────────────
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modelDropdownRef = useRef<HTMLDivElement>(null);

    // ─── Derived state ───────────────────────────────────────────────────────
    const activeConversation = conversations.find(c => c.id === activeConvId) || null;
    const messages = activeConversation?.messages || [];

    // ─── Effects ─────────────────────────────────────────────────────────────

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

    useEffect(() => { checkProxyStatus(); }, []);

    // Close model dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
                setModelDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // ─── Proxy ───────────────────────────────────────────────────────────────

    const checkProxyStatus = async () => {
        setIsCheckingProxy(true);
        try {
            const status = await invoke<ProxyStatus>('get_proxy_status');
            setProxyStatus(status);
        } catch (error) {
            console.error('Failed to get proxy status:', error);
        } finally {
            setIsCheckingProxy(false);
        }
    };

    // ─── Conversation management ─────────────────────────────────────────────

    const createConversation = useCallback(() => {
        const conv: Conversation = {
            id: crypto.randomUUID(),
            title: 'New Chat',
            messages: [],
            model: selectedModel,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        setConversations(prev => [conv, ...prev]);
        setActiveConvId(conv.id);
        setInput('');
        setAttachments([]);
        textareaRef.current?.focus();
    }, [selectedModel]);

    const deleteConversation = useCallback((id: string) => {
        setConversations(prev => prev.filter(c => c.id !== id));
        if (activeConvId === id) {
            setActiveConvId(_ => {
                const remaining = conversations.filter(c => c.id !== id);
                return remaining.length > 0 ? remaining[0].id : null;
            });
        }
    }, [activeConvId, conversations]);

    const updateConversationMessages = useCallback((convId: string, updater: (msgs: Message[]) => Message[]) => {
        setConversations(prev => prev.map(c =>
            c.id === convId
                ? { ...c, messages: updater(c.messages), updatedAt: Date.now() }
                : c
        ));
    }, []);

    const updateConversationTitle = useCallback((convId: string, firstMessage: string) => {
        const title = firstMessage.length > 40 ? firstMessage.slice(0, 40) + '...' : firstMessage;
        setConversations(prev => prev.map(c =>
            c.id === convId ? { ...c, title } : c
        ));
    }, []);

    // ─── File handling ───────────────────────────────────────────────────────

    const compressImage = (file: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = (event) => {
                const img = new Image();
                img.src = event.target?.result as string;
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const MAX_SIZE = 1536;
                    if (width > MAX_SIZE || height > MAX_SIZE) {
                        if (width > height) { height *= MAX_SIZE / width; width = MAX_SIZE; }
                        else { width *= MAX_SIZE / height; height = MAX_SIZE; }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) { reject(new Error("Canvas context failed")); return; }
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                img.onerror = reject;
            };
            reader.onerror = reject;
        });
    };

    const processFiles = (files: FileList | null) => {
        if (!files) return;
        const newAttachments: Attachment[] = [];
        const promises: Promise<void>[] = [];

        Array.from(files).forEach(file => {
            const isImage = file.type.startsWith('image/');
            const promise = new Promise<void>((resolve) => {
                if (isImage) {
                    compressImage(file).then((compressed) => {
                        newAttachments.push({ id: crypto.randomUUID(), type: 'image', content: compressed, name: file.name, mimeType: 'image/jpeg' });
                        resolve();
                    }).catch(() => resolve());
                } else {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        if (typeof reader.result === 'string') {
                            newAttachments.push({ id: crypto.randomUUID(), type: 'file', content: reader.result, name: file.name, mimeType: file.type });
                        }
                        resolve();
                    };
                    reader.readAsText(file);
                }
            });
            promises.push(promise);
        });

        Promise.all(promises).then(() => setAttachments(prev => [...prev, ...newAttachments]));
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        processFiles(e.target.files);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragOver(false);
        processFiles(e.dataTransfer.files);
    };

    // ─── Send message ────────────────────────────────────────────────────────

    const handleSend = async (overrideText?: string) => {
        const text = overrideText ?? input;
        if ((!text.trim() && attachments.length === 0) || !proxyStatus?.running) return;

        // Ensure we have an active conversation
        let convId = activeConvId;
        if (!convId) {
            const conv: Conversation = {
                id: crypto.randomUUID(),
                title: 'New Chat',
                messages: [],
                model: selectedModel,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            setConversations(prev => [conv, ...prev]);
            setActiveConvId(conv.id);
            convId = conv.id;
        }

        const currentAttachments = [...attachments];
        const attachedImages = currentAttachments.filter(a => a.type === 'image').map(a => a.content);
        const attachedFiles = currentAttachments.filter(a => a.type === 'file');

        let finalContent = text.trim();
        if (attachedFiles.length > 0) {
            finalContent += attachedFiles.map(f =>
                `\n\n--- File: ${f.name} ---\n${f.content}\n--- End of File ${f.name} ---`
            ).join('\n');
        }
        if (!finalContent.trim() && attachedImages.length === 0) return;

        const userMessage: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: finalContent,
            images: attachedImages.length > 0 ? attachedImages : undefined,
            timestamp: Date.now(),
            status: 'completed'
        };

        const assistantMessageId = crypto.randomUUID();
        const assistantMessage: Message = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'streaming'
        };

        // Update title on first message
        updateConversationMessages(convId, msgs => {
            if (msgs.length === 0) {
                updateConversationTitle(convId!, finalContent);
            }
            return [...msgs, userMessage, assistantMessage];
        });

        setInput('');
        setAttachments([]);
        setIsLoading(true);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';

        try {
            abortControllerRef.current = new AbortController();
            const baseUrl = `http://127.0.0.1:${proxyStatus.port}/v1`;
            await fetchStream(baseUrl, convId, userMessage, assistantMessageId);
        } catch (error: any) {
            if (error.name === 'AbortError') {
                updateConversationMessages(convId, msgs =>
                    msgs.map(m => m.id === assistantMessageId ? { ...m, status: 'completed' as const } : m)
                );
            } else {
                updateConversationMessages(convId, msgs =>
                    msgs.map(m => m.id === assistantMessageId ? { ...m, status: 'error' as const, error: error.toString() } : m)
                );
                showToast(t('common.error') + ': ' + error.toString(), 'error');
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    };

    const fetchStream = async (baseUrl: string, convId: string, userMessage: Message, messageId: string) => {
        // Get current messages from the conversation
        const conv = conversations.find(c => c.id === convId);
        const currentMessages = conv?.messages || [];

        const validHistory = currentMessages.filter(m =>
            m.status === 'completed' && (m.content.trim() !== '' || (m.images && m.images.length > 0))
        );

        const history = validHistory.slice(-10).map(m => {
            if (m.images && m.images.length > 0) {
                return {
                    role: m.role,
                    content: [
                        { type: 'text', text: m.content },
                        ...m.images.map(img => ({ type: 'image_url', image_url: { url: img } }))
                    ]
                };
            }
            return { role: m.role, content: m.content };
        });

        let currentMessageContent: any = userMessage.content;
        if (userMessage.images && userMessage.images.length > 0) {
            currentMessageContent = [
                { type: 'text', text: userMessage.content },
                ...userMessage.images.map(img => ({ type: 'image_url', image_url: { url: img } }))
            ];
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config?.proxy.api_key || 'sk-antigravity'}`
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: [...history, { role: 'user', content: currentMessageContent }],
                stream: true
            }),
            signal: abortControllerRef.current?.signal
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API Error: ${response.status} - ${errorText}`);
        }
        if (!response.body) throw new Error('No response body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantContent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        assistantContent += delta;
                        const content = assistantContent;
                        updateConversationMessages(convId, msgs =>
                            msgs.map(m => m.id === messageId ? { ...m, content } : m)
                        );
                    }
                } catch (e) {
                    console.warn('Failed to parse stream chunk:', e);
                }
            }
        }

        updateConversationMessages(convId, msgs =>
            msgs.map(m => m.id === messageId ? { ...m, status: 'completed' as const } : m)
        );
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
        }
    };

    const handleClearChat = () => {
        if (activeConvId && confirm(t('Are you sure you want to clear the chat history?'))) {
            updateConversationMessages(activeConvId, () => []);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    };

    // ─── Model helpers ───────────────────────────────────────────────────────

    const groupedModels = useMemo(() => {
        const groups: Record<string, typeof models> = {};
        models.forEach(m => {
            if (!groups[m.group]) groups[m.group] = [];
            groups[m.group].push(m);
        });
        return groups;
    }, [models]);

    const currentModel = models.find(m => m.id === selectedModel);

    // ─── Markdown renderer ───────────────────────────────────────────────────

    const renderMessageContent = (content: string) => {
        const fileBlockRegex = /(--- File: .*? ---\n[\s\S]*?\n--- End of File .*? ---)/g;
        const fileParts = content.split(fileBlockRegex);

        return fileParts.map((part, i) => {
            const fileMatch = part.match(/--- File: (.*?) ---\n([\s\S]*?)\n--- End of File \1 ---/);
            if (fileMatch) {
                return (
                    <details key={i} className="my-2 border border-base-300 rounded-lg bg-base-100 dark:bg-base-300 overflow-hidden">
                        <summary className="px-3 py-2 cursor-pointer hover:bg-base-200 dark:hover:bg-base-200/50 text-xs font-semibold flex items-center gap-2 select-none">
                            <FileIcon size={14} className="opacity-70" />
                            <span>File: {fileMatch[1]}</span>
                            <span className="ml-auto opacity-50 text-[10px]">{fileMatch[2].length} chars</span>
                        </summary>
                        <div className="p-3 bg-base-200/50 dark:bg-base-300/50 border-t border-base-300 overflow-x-auto">
                            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                                {fileMatch[2]}
                            </pre>
                        </div>
                    </details>
                );
            }

            let markdownContent = part;
            markdownContent = markdownContent.replace(/```(?:[\w-]*\n)?([\s\S]*?)```/g, (match, inside) => {
                if (inside.trim().match(/^!\[[\s\S]*?\]\([\s\S]*?\)$/)) return inside.trim();
                return match;
            });
            if (markdownContent.trim().match(/^data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+$/)) {
                markdownContent = `![Generated Image](${markdownContent.trim()})`;
            }

            return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none break-words">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            img: ({ node, ...props }) => (
                                <img
                                    {...props}
                                    className="max-w-full h-auto rounded-lg my-2 border border-base-300 mx-auto cursor-pointer hover:opacity-90 transition-opacity"
                                    onClick={() => window.open(props.src, '_blank')}
                                />
                            ),
                            a: ({ node, ...props }) => (
                                <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />
                            ),
                            pre: ({ node, ...props }) => (
                                <div className="mockup-code bg-base-300 text-base-content scale-90 -ml-4 origin-top-left w-[110%] my-4">
                                    <pre {...props} className="bg-transparent px-5 py-2 overflow-x-auto" />
                                </div>
                            )
                        }}
                    >
                        {markdownContent}
                    </ReactMarkdown>
                </div>
            );
        });
    };

    // ─── Loading state ───────────────────────────────────────────────────────

    if (isCheckingProxy) {
        return (
            <div className="flex h-full items-center justify-center bg-[#FAFBFC] dark:bg-base-300">
                <Loader2 className="animate-spin text-primary" size={32} />
            </div>
        );
    }

    if (!proxyStatus?.running) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center space-y-4 bg-[#FAFBFC] dark:bg-base-300">
                <div className="w-20 h-20 rounded-2xl bg-orange-100 dark:bg-orange-900/20 flex items-center justify-center">
                    <AlertCircle size={40} className="text-orange-500" />
                </div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-base-content">{t('proxy.status.stopped')}</h2>
                <p className="text-gray-500 dark:text-gray-400 max-w-md text-sm">
                    {t('The local API proxy service is not running. Please start it in the API Proxy tab to use the chat feature.')}
                </p>
                <a href="/api-proxy" className="mt-2 px-6 py-2.5 bg-primary text-white rounded-full font-medium text-sm hover:opacity-90 transition-opacity shadow-lg shadow-primary/25">
                    {t('Go to API Proxy')}
                </a>
            </div>
        );
    }

    // ─── Main Render ─────────────────────────────────────────────────────────

    return (
        <div className="flex h-full bg-[#FAFBFC] dark:bg-base-300 overflow-hidden">

            {/* ─── Sidebar ──────────────────────────────────────────────── */}
            <div className={cn(
                "flex-none flex flex-col border-r border-gray-200 dark:border-base-200 bg-white dark:bg-base-100 transition-all duration-300 ease-in-out overflow-hidden",
                sidebarOpen ? "w-[280px]" : "w-0"
            )}>
                {/* Sidebar header */}
                <div className="flex-none p-4 border-b border-gray-100 dark:border-base-200">
                    <button
                        onClick={createConversation}
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl text-sm font-medium hover:opacity-90 transition-all shadow-sm active:scale-[0.98]"
                    >
                        <Plus size={16} />
                        <span>{t('New Chat')}</span>
                    </button>
                </div>

                {/* Conversation list */}
                <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-base-200">
                    {conversations.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-32 opacity-40">
                            <MessageCircle size={24} className="mb-2" />
                            <span className="text-xs">{t('No conversations yet')}</span>
                        </div>
                    ) : (
                        conversations.map(conv => (
                            <div
                                key={conv.id}
                                onClick={() => setActiveConvId(conv.id)}
                                className={cn(
                                    "group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all text-sm",
                                    activeConvId === conv.id
                                        ? "bg-gray-100 dark:bg-base-200 text-gray-900 dark:text-base-content font-medium"
                                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-base-200/50"
                                )}
                            >
                                <MessageCircle size={14} className="flex-none opacity-50" />
                                <span className="flex-1 truncate">{conv.title}</span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                                    className="flex-none opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:text-red-500 transition-all p-0.5"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                {/* Sidebar footer — Model selector */}
                <div className="flex-none p-3 border-t border-gray-100 dark:border-base-200" ref={modelDropdownRef}>
                    <button
                        onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-base-200 rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-base-200/80 transition-colors"
                    >
                        <Bot size={14} className="text-primary flex-none" />
                        <span className="flex-1 text-left truncate text-gray-700 dark:text-gray-300 text-xs font-medium">
                            {currentModel?.name || selectedModel}
                        </span>
                        <ChevronDown size={14} className={cn("text-gray-400 transition-transform", modelDropdownOpen && "rotate-180")} />
                    </button>

                    {/* Model dropdown */}
                    {modelDropdownOpen && (
                        <div className="absolute bottom-16 left-2 w-[264px] bg-white dark:bg-base-100 rounded-xl shadow-xl border border-gray-200 dark:border-base-200 py-1 max-h-[400px] overflow-y-auto z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
                            {Object.entries(groupedModels).map(([group, groupModels]) => (
                                <div key={group}>
                                    <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                        {group}
                                    </div>
                                    {groupModels.map(model => (
                                        <button
                                            key={model.id}
                                            onClick={() => { setSelectedModel(model.id); setModelDropdownOpen(false); }}
                                            className={cn(
                                                "w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-base-200 transition-colors",
                                                selectedModel === model.id && "bg-primary/5 text-primary font-medium"
                                            )}
                                        >
                                            <span className="flex-none text-primary/70">{model.icon}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="truncate text-xs font-medium">{model.name}</div>
                                                <div className="truncate text-[10px] text-gray-400 dark:text-gray-500">{model.desc}</div>
                                            </div>
                                            {selectedModel === model.id && (
                                                <div className="flex-none w-1.5 h-1.5 rounded-full bg-primary" />
                                            )}
                                        </button>
                                    ))}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ─── Main Chat Area ───────────────────────────────────────── */}
            <div
                className="flex-1 flex flex-col min-w-0 relative"
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
            >
                {/* Drag overlay */}
                {isDragOver && (
                    <div className="absolute inset-0 z-50 bg-primary/5 border-2 border-dashed border-primary/30 rounded-xl m-4 flex items-center justify-center backdrop-blur-sm">
                        <div className="flex flex-col items-center gap-2 text-primary">
                            <Paperclip size={32} />
                            <span className="text-sm font-medium">{t('Drop files here')}</span>
                        </div>
                    </div>
                )}

                {/* Chat header */}
                <div className="flex-none flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-base-200 bg-white/80 dark:bg-base-100/80 backdrop-blur-sm">
                    <button
                        onClick={() => setSidebarOpen(!sidebarOpen)}
                        className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-base-200 transition-colors text-gray-500"
                        title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                    >
                        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
                    </button>

                    <div className="flex-1 min-w-0">
                        <h2 className="text-sm font-semibold text-gray-900 dark:text-base-content truncate">
                            {activeConversation?.title || t('New Chat')}
                        </h2>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                            <span className={`w-1.5 h-1.5 rounded-full ${proxyStatus?.running ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span>{currentModel?.name || selectedModel}</span>
                        </div>
                    </div>

                    {messages.length > 0 && (
                        <button
                            onClick={handleClearChat}
                            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-base-200 transition-colors text-gray-400 hover:text-red-500"
                            title={t('Clear Chat')}
                        >
                            <Eraser size={16} />
                        </button>
                    )}
                </div>

                {/* Messages area */}
                <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 scroll-smooth">
                    {messages.length === 0 ? (
                        /* ─── Empty state ─── */
                        <div className="h-full flex flex-col items-center justify-center">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center mb-5">
                                <Sparkles size={28} className="text-primary" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900 dark:text-base-content mb-1">
                                {t('How can I help you today?')}
                            </h3>
                            <p className="text-sm text-gray-400 dark:text-gray-500 mb-8">
                                {t('Start a conversation or try one of these suggestions')}
                            </p>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg w-full">
                                {SUGGESTIONS.map((s, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => handleSend(s.text)}
                                        className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-base-100 border border-gray-200 dark:border-base-200 rounded-xl text-left text-sm text-gray-700 dark:text-gray-300 hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm transition-all group"
                                    >
                                        <span className="text-lg">{s.icon}</span>
                                        <span className="flex-1 line-clamp-2">{s.text}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        /* ─── Message list ─── */
                        messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={cn(
                                    "flex gap-3 max-w-3xl mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300",
                                    msg.role === 'user' ? "justify-end" : "justify-start"
                                )}
                            >
                                {msg.role !== 'user' && (
                                    <div className="flex-none w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center mt-1 ring-1 ring-primary/10">
                                        <Bot size={15} className="text-primary" />
                                    </div>
                                )}

                                <div className={cn("flex flex-col gap-1 max-w-[85%]", msg.role === 'user' ? "items-end" : "items-start")}>
                                    {/* Attached images */}
                                    {msg.images && msg.images.length > 0 && (
                                        <div className={cn("flex flex-wrap gap-2 mb-1", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                            {msg.images.map((img, idx) => (
                                                <img
                                                    key={idx}
                                                    src={img}
                                                    alt="Attached"
                                                    className="w-32 h-32 object-cover rounded-xl border border-gray-200 dark:border-base-200 shadow-sm hover:scale-105 transition-transform cursor-pointer"
                                                    onClick={() => window.open(img, '_blank')}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {/* Message bubble */}
                                    <div className={cn(
                                        "px-4 py-3 rounded-2xl whitespace-pre-wrap leading-relaxed shadow-sm overflow-hidden",
                                        msg.role === 'user'
                                            ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-tr-md"
                                            : "bg-white dark:bg-base-100 border border-gray-200 dark:border-base-200 rounded-tl-md"
                                    )}>
                                        {renderMessageContent(msg.content)}
                                        {msg.status === 'streaming' && (
                                            <span className="inline-block w-2 h-4 ml-1 align-middle bg-current opacity-50 animate-pulse rounded-sm" />
                                        )}
                                        {msg.role === 'assistant' && msg.status !== 'streaming' && msg.content && (
                                            <div className="flex justify-end mt-2 pt-2 border-t border-gray-100 dark:border-base-200">
                                                <CopyButton content={msg.content} />
                                            </div>
                                        )}
                                    </div>

                                    {/* Error */}
                                    {msg.error && (
                                        <span className="text-xs text-red-500 flex items-center gap-1">
                                            <AlertCircle size={12} /> {msg.error}
                                        </span>
                                    )}

                                    {/* Timestamp */}
                                    <span className="text-[10px] text-gray-400 dark:text-gray-500 px-1">
                                        {new Date(msg.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>

                                {msg.role === 'user' && (
                                    <div className="flex-none w-8 h-8 rounded-full bg-gray-200 dark:bg-base-200 flex items-center justify-center mt-1">
                                        <User size={15} className="text-gray-500 dark:text-gray-400" />
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* ─── Input area ─── */}
                <div className="flex-none bg-white dark:bg-base-100 border-t border-gray-200 dark:border-base-200 px-4 md:px-8 py-4">
                    <div className="max-w-3xl mx-auto">
                        {/* Attachment previews */}
                        {attachments.length > 0 && (
                            <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-gray-200">
                                {attachments.map((att, idx) => (
                                    <div key={att.id} className="relative group flex-none">
                                        {att.type === 'image' ? (
                                            <img src={att.content} alt={att.name} className="w-14 h-14 object-cover rounded-lg border border-gray-200 dark:border-base-200" />
                                        ) : (
                                            <div className="w-14 h-14 flex flex-col items-center justify-center bg-gray-50 dark:bg-base-200 rounded-lg border border-gray-200 dark:border-base-200 p-1">
                                                <FileIcon size={20} className="text-gray-400 mb-0.5" />
                                                <span className="text-[7px] text-gray-400 truncate w-full text-center">{att.name}</span>
                                            </div>
                                        )}
                                        <button
                                            onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                                            className="absolute -top-1.5 -right-1.5 bg-gray-500 hover:bg-red-500 text-white rounded-full p-0.5 shadow-md transition-colors"
                                        >
                                            <X size={10} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Input box */}
                        <div className="relative bg-gray-50 dark:bg-base-200 rounded-2xl border border-gray-200 dark:border-base-200 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 transition-all shadow-sm">
                            <textarea
                                ref={textareaRef}
                                value={input}
                                onChange={handleInput}
                                onKeyDown={handleKeyDown}
                                placeholder={t('Type a message...')}
                                className="w-full bg-transparent border-none focus:ring-0 focus:outline-none rounded-2xl pl-12 pr-14 py-3.5 min-h-[52px] max-h-[200px] resize-none text-sm text-gray-900 dark:text-base-content placeholder-gray-400"
                                disabled={isLoading && !proxyStatus?.running}
                            />

                            {/* Attach button */}
                            <div className="absolute left-2 bottom-2.5">
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    multiple
                                    onChange={handleFileSelect}
                                />
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isLoading}
                                    className="p-2 rounded-lg text-gray-400 hover:text-primary hover:bg-primary/10 transition-colors"
                                    title={t('Attach File')}
                                >
                                    <Paperclip size={18} />
                                </button>
                            </div>

                            {/* Send / Stop button */}
                            <div className="absolute right-2 bottom-2.5">
                                {isLoading ? (
                                    <button
                                        onClick={handleStop}
                                        className="p-2 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors shadow-sm"
                                        title={t('Stop generating')}
                                    >
                                        <StopCircle size={18} />
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => handleSend()}
                                        disabled={(!input.trim() && attachments.length === 0) || !proxyStatus?.running}
                                        className={cn(
                                            "p-2 rounded-lg transition-all shadow-sm",
                                            (input.trim() || attachments.length > 0)
                                                ? "bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90"
                                                : "bg-gray-200 dark:bg-base-300 text-gray-400 cursor-not-allowed"
                                        )}
                                    >
                                        <Send size={18} />
                                    </button>
                                )}
                            </div>
                        </div>

                        <p className="text-center mt-2 text-[10px] text-gray-400 dark:text-gray-500">
                            {t('AI can make mistakes. Please check important information.')}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Copy Button ─────────────────────────────────────────────────────────────

function CopyButton({ content }: { content: string }) {
    const [isCopied, setIsCopied] = useState(false);
    const { t } = useTranslation();

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setIsCopied(true);
            showToast(t('Copied to clipboard'), 'success');
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
            showToast(t('Failed to copy'), 'error');
        }
    };

    return (
        <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-primary hover:bg-gray-50 dark:hover:bg-base-200 transition-colors"
            title={t('Copy content')}
        >
            {isCopied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
            <span>{isCopied ? t('Copied') : t('Copy')}</span>
        </button>
    );
}

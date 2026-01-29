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
    Upload
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '../stores/useConfigStore';
import { useProxyModels } from '../hooks/useProxyModels';
import { cn } from '../utils/cn';
import { showToast } from '../components/common/ToastContainer';

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[]; // Base64 data URIs
    timestamp: number;
    status?: 'sending' | 'streaming' | 'completed' | 'error';
    error?: string;
}

interface ProxyStatus {
    running: boolean;
    port: number;
    base_url: string;
    active_accounts: number;
}

export default function ChatView() {
    const { t } = useTranslation();
    const { config } = useConfigStore();
    const { models } = useProxyModels();
    
    // State
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [selectedModel, setSelectedModel] = useState('gemini-3-pro-image-16-9');
    const [isLoading, setIsLoading] = useState(false);
    const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
    const [isCheckingProxy, setIsCheckingProxy] = useState(true);
    const [attachments, setAttachments] = useState<string[]>([]); // Base64 images
    const [isDragging, setIsDragging] = useState(false);
    
    // Refs
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Auto-scroll to bottom
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, attachments]); // Scroll when messages or attachments change (preview might change height)

    // Check proxy status on mount
    useEffect(() => {
        checkProxyStatus();
    }, []);

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

    // File handling helpers
    const processFiles = (files: FileList | null) => {
        if (!files) return;
        
        const newAttachments: string[] = [];
        const promises: Promise<void>[] = [];

        Array.from(files).forEach(file => {
            if (!file.type.startsWith('image/')) {
                showToast(t('Only image files are supported'), 'warning');
                return;
            }

            const promise = new Promise<void>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (typeof reader.result === 'string') {
                        newAttachments.push(reader.result);
                    }
                    resolve();
                };
                reader.readAsDataURL(file);
            });
            promises.push(promise);
        });

        Promise.all(promises).then(() => {
            setAttachments(prev => [...prev, ...newAttachments]);
        });
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        processFiles(e.target.files);
        // Reset input so same file can be selected again
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    // Drag and Drop handlers
    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isLoading) {
            setIsDragging(true);
        }
    }, [isLoading]);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (isLoading || !proxyStatus?.running) return;

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            processFiles(files);
        }
    }, [isLoading, proxyStatus]);


    const handleSend = async () => {
        if ((!input.trim() && attachments.length === 0) || !proxyStatus?.running) return;

        const currentAttachments = [...attachments]; // Capture current attachments
        const currentInput = input.trim();

        const userMessage: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: currentInput,
            images: currentAttachments.length > 0 ? currentAttachments : undefined,
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

        setMessages(prev => [...prev, userMessage, assistantMessage]);
        setInput('');
        setAttachments([]); // Clear attachments immediately
        setIsLoading(true);

        // Reset textarea height
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }

        try {
            abortControllerRef.current = new AbortController();
            
            // Construct API URL
            // Use 127.0.0.1 to avoid IPv6 issues
            const baseUrl = `http://127.0.0.1:${proxyStatus.port}/v1`;
            
            await fetchStream(baseUrl, userMessage, assistantMessageId);
            
        } catch (error: any) {
            if (error.name === 'AbortError') {
                updateMessageStatus(assistantMessageId, 'completed');
            } else {
                updateMessageStatus(assistantMessageId, 'error', error.toString());
                showToast(t('common.error') + ': ' + error.toString(), 'error');
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    };

    const fetchStream = async (baseUrl: string, userMessage: Message, messageId: string) => {
        // Prepare context from previous messages
        // Filter out empty or error messages to avoid 400 Invalid Argument errors
        const validHistory = messages.filter(m => 
            m.status === 'completed' && 
            (m.content.trim() !== '' || (m.images && m.images.length > 0))
        );

        // Take last 10 messages from valid history
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
            return {
                role: m.role,
                content: m.content
            };
        });

        // Prepare current message content
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
                        updateMessageContent(messageId, assistantContent);
                    }
                } catch (e) {
                    console.warn('Failed to parse stream chunk:', e);
                }
            }
        }
        
        updateMessageStatus(messageId, 'completed');
    };

    const updateMessageContent = (id: string, newContent: string) => {
        setMessages(prev => prev.map(msg => 
            msg.id === id ? { ...msg, content: newContent } : msg
        ));
    };

    const updateMessageStatus = (id: string, status: Message['status'], error?: string) => {
        setMessages(prev => prev.map(msg => 
            msg.id === id ? { ...msg, status, error } : msg
        ));
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
        }
    };

    const handleClearChat = () => {
        if (confirm(t('Are you sure you want to clear the chat history?'))) {
            setMessages([]);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // Auto-resize textarea
    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    };

    // Helper to render message content with basic markdown image support
    const renderMessageContent = (content: string) => {
        // Regex to match markdown images: ![alt](url)
        // We use a simple split to separate text blocks from image blocks
        const parts = content.split(/(!\[.*?\]\(.*?\))/g);
        
        return parts.map((part, index) => {
            const imageMatch = part.match(/!\[(.*?)\]\((.*?)\)/);
            if (imageMatch) {
                const alt = imageMatch[1];
                const src = imageMatch[2];
                return (
                    <img 
                        key={index} 
                        src={src} 
                        alt={alt} 
                        className="max-w-full h-auto rounded-lg my-2 border border-base-300 mx-auto"
                        onClick={() => window.open(src, '_blank')}
                    />
                );
            }
            // For regular text, we want to preserve newlines
            return <span key={index}>{part}</span>;
        });
    };

    // Filter relevant models
    const sortedModels = useMemo(() => {
        return [...models].sort((a, b) => a.group.localeCompare(b.group));
    }, [models]);

    if (isCheckingProxy) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="animate-spin text-primary" size={32} />
            </div>
        );
    }

    if (!proxyStatus?.running) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center space-y-4">
                <div className="bg-orange-100 dark:bg-orange-900/20 p-4 rounded-full">
                    <AlertCircle size={48} className="text-orange-500" />
                </div>
                <h2 className="text-2xl font-bold">{t('proxy.status.stopped')}</h2>
                <p className="text-base-content/70 max-w-md">
                    {t('The local API proxy service is not running. Please start it in the API Proxy tab to use the chat feature.')}
                </p>
                <a href="/api-proxy" className="btn btn-primary">
                    {t('Go to API Proxy')}
                </a>
            </div>
        );
    }

    return (
        <div 
            className="flex flex-col h-full bg-base-100 dark:bg-base-300 relative"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
             {/* Drag Overlay */}
             {isDragging && (
                <div className="absolute inset-0 z-50 bg-primary/10 backdrop-blur-sm border-2 border-dashed border-primary m-4 rounded-2xl flex flex-col items-center justify-center text-primary pointer-events-none">
                    <Upload size={48} className="mb-4 animate-bounce" />
                    <p className="text-xl font-bold">{t('Drop images here to attach')}</p>
                </div>
            )}

            {/* Chat Area */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth">
                {messages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-40 select-none">
                        <Bot size={64} className="mb-4 text-base-content/20" />
                        <p className="text-lg font-medium">{t('How can I help you today?')}</p>
                    </div>
                ) : (
                    messages.map((msg) => (
                        <div 
                            key={msg.id} 
                            className={cn(
                                "flex gap-4 max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300",
                                msg.role === 'user' ? "justify-end" : "justify-start"
                            )}
                        >
                            {msg.role !== 'user' && (
                                <div className="flex-none w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mt-1">
                                    <Bot size={16} className="text-primary" />
                                </div>
                            )}
                            
                            <div className={cn(
                                "flex flex-col gap-1 max-w-[85%]",
                                msg.role === 'user' ? "items-end" : "items-start"
                            )}>
                                {/* Display Attached Images */}
                                {msg.images && msg.images.length > 0 && (
                                    <div className={cn(
                                        "flex flex-wrap gap-2 mb-1",
                                        msg.role === 'user' ? "justify-end" : "justify-start"
                                    )}>
                                        {msg.images.map((img, idx) => (
                                            <img 
                                                key={idx} 
                                                src={img} 
                                                alt="Attached" 
                                                className="w-32 h-32 object-cover rounded-lg border border-base-300 shadow-sm transition-transform hover:scale-105 cursor-pointer"
                                                onClick={() => window.open(img, '_blank')}
                                            />
                                        ))}
                                    </div>
                                )}

                                <div className={cn(
                                    "px-4 py-3 rounded-2xl whitespace-pre-wrap leading-relaxed shadow-sm overflow-hidden",
                                    msg.role === 'user' 
                                        ? "bg-primary text-primary-content rounded-tr-sm" 
                                        : "bg-white dark:bg-base-200 border border-base-200 dark:border-base-100 rounded-tl-sm"
                                )}>
                                    {renderMessageContent(msg.content)}
                                    {msg.status === 'streaming' && (
                                        <span className="inline-block w-2 h-4 ml-1 align-middle bg-current opacity-50 animate-pulse"></span>
                                    )}
                                </div>
                                {msg.error && (
                                    <span className="text-xs text-error flex items-center gap-1">
                                        <AlertCircle size={12} /> {msg.error}
                                    </span>
                                )}
                                <span className="text-[10px] text-base-content/40 px-1">
                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            {msg.role === 'user' && (
                                <div className="flex-none w-8 h-8 rounded-full bg-base-300 dark:bg-base-100 flex items-center justify-center mt-1">
                                    <User size={16} className="text-base-content/60" />
                                </div>
                            )}
                        </div>
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="flex-none bg-white dark:bg-base-100 border-t border-base-200 p-4 md:px-6 md:py-5 z-20">
                <div className="max-w-4xl mx-auto relative group">
                    {/* Model Selector & Actions */}
                    <div className="flex items-center gap-2 mb-2">
                         <div className="relative">
                            <select 
                                className="select select-sm select-bordered rounded-full pl-8 pr-8 h-8 min-h-0 bg-base-200/50 border-base-200 hover:border-base-300 focus:outline-none focus:border-primary text-xs font-medium"
                                value={selectedModel}
                                onChange={(e) => setSelectedModel(e.target.value)}
                                disabled={isLoading}
                            >
                                {sortedModels.map(model => (
                                    <option key={model.id} value={model.id}>
                                        {model.name}
                                    </option>
                                ))}
                            </select>
                            <Bot size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-primary pointer-events-none" />
                        </div>

                        {messages.length > 0 && (
                            <button 
                                className="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-error"
                                onClick={handleClearChat}
                                title={t('Clear Chat')}
                            >
                                <Eraser size={14} />
                            </button>
                        )}
                        
                        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-base-content/40">
                             <span className={`w-1.5 h-1.5 rounded-full ${proxyStatus?.running ? 'bg-green-500' : 'bg-red-500'}`}></span>
                             <span>{proxyStatus?.running ? 'Ready' : 'Stopped'}</span>
                        </div>
                    </div>
                    
                    {/* Attachments Preview */}
                    {attachments.length > 0 && (
                        <div className="flex items-center gap-2 mb-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-base-300">
                            {attachments.map((img, idx) => (
                                <div key={idx} className="relative group/preview flex-none">
                                    <img src={img} alt="preview" className="w-16 h-16 object-cover rounded-lg border border-base-300" />
                                    <button 
                                        onClick={() => removeAttachment(idx)}
                                        className="absolute -top-1.5 -right-1.5 bg-gray-500 hover:bg-red-500 text-white rounded-full p-0.5 shadow-md transition-colors"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea
                        ref={textareaRef}
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        placeholder={t('Type a message...')}
                        className="w-full bg-gray-50 dark:bg-base-200 border-transparent focus:border-primary focus:ring-0 rounded-2xl pl-12 pr-14 py-3 min-h-[50px] max-h-[200px] resize-none scrollbar-hide shadow-inner transition-colors"
                        disabled={isLoading && !proxyStatus?.running}
                    />
                    
                    {/* Attachment Button */}
                    <div className="absolute left-2 bottom-4">
                         <input 
                            type="file" 
                            ref={fileInputRef}
                            className="hidden" 
                            accept="image/*" 
                            multiple 
                            onChange={handleFileSelect}
                        />
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isLoading}
                            className="btn btn-circle btn-sm btn-ghost text-base-content/50 hover:text-primary hover:bg-primary/10 transition-colors"
                            title={t('Attach Image')}
                        >
                            <Paperclip size={20} />
                        </button>
                    </div>

                    {/* Send/Stop Button */}
                    <div className="absolute right-2 bottom-4">
                        {isLoading ? (
                            <button 
                                onClick={handleStop}
                                className="btn btn-circle btn-sm btn-error shadow-md"
                                title={t('Stop generating')}
                            >
                                <StopCircle size={18} />
                            </button>
                        ) : (
                            <button 
                                onClick={handleSend}
                                disabled={(!input.trim() && attachments.length === 0) || !proxyStatus?.running}
                                className={cn(
                                    "btn btn-circle btn-sm shadow-md transition-all",
                                    (input.trim() || attachments.length > 0) ? "btn-primary" : "btn-ghost bg-base-300 text-base-content/40 hover:bg-base-300"
                                )}
                            >
                                <Send size={18} className={input.trim() ? "ml-0.5" : ""} />
                            </button>
                        )}
                    </div>
                </div>
                <div className="text-center mt-2">
                    <p className="text-[10px] text-base-content/40">
                        {t('AI can make mistakes. Please check important information.')}
                    </p>
                </div>
            </div>
        </div>
    );
}

import { useState, useEffect, useRef, useMemo } from 'react';
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
    Check
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfigStore } from '../stores/useConfigStore';
import { useProxyModels } from '../hooks/useProxyModels';
import { cn } from '../utils/cn';
import { showToast } from '../components/common/ToastContainer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[]; // Base64 data URIs
    timestamp: number;
    status?: 'sending' | 'streaming' | 'completed' | 'error';
    error?: string;
}

interface Attachment {
    id: string;
    type: 'image' | 'file';
    content: string; // Base64 for images, text content for files
    name: string;
    mimeType?: string;
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
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    
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
        
        const newAttachments: Attachment[] = [];
        const promises: Promise<void>[] = [];

        Array.from(files).forEach(file => {
            const isImage = file.type.startsWith('image/');
            // Simple check for text/code files based on common types or lack of binary signature
            // For now, we'll try to read everything that isn't an image as text, 
            // but ideally we could filter.
            
            const promise = new Promise<void>((resolve) => {
                const reader = new FileReader();
                
                if (isImage) {
                    compressImage(file).then((compressedContent) => {
                        newAttachments.push({
                            id: crypto.randomUUID(),
                            type: 'image',
                            content: compressedContent,
                            name: file.name,
                            mimeType: 'image/jpeg' // Compressed is usually jpeg/webp
                        });
                        resolve();
                    }).catch(err => {
                        console.error("Image compression failed", err);
                        resolve();
                    });
                } else {
                    reader.onloadend = () => {
                        if (typeof reader.result === 'string') {
                            newAttachments.push({
                                id: crypto.randomUUID(),
                                type: 'file',
                                content: reader.result,
                                name: file.name,
                                mimeType: file.type
                            });
                        }
                        resolve();
                    };
                    // Attempt to read as text. If it's a binary file like .exe, this might produce garbage,
                    // but for code/config/logs it works well.
                    reader.readAsText(file);
                }
            });
            promises.push(promise);
        });

        Promise.all(promises).then(() => {
            setAttachments(prev => [...prev, ...newAttachments]);
        });
    };

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
                    
                    // Resize if too large (max 1536px to be safe for 5MB limit even with complexity)
                    const MAX_SIZE = 1536; 
                    if (width > MAX_SIZE || height > MAX_SIZE) {
                        if (width > height) {
                            height *= MAX_SIZE / width;
                            width = MAX_SIZE;
                        } else {
                            width *= MAX_SIZE / height;
                            height = MAX_SIZE;
                        }
                    }
                    
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error("Failed to get canvas context"));
                        return;
                    }
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Compress to JPEG with 0.85 quality
                    // This converts PNG/Heavy formats to optimized JPEG
                    const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    resolve(compressedDataUrl);
                };
                img.onerror = error => reject(error);
            };
            reader.onerror = error => reject(error);
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



    const handleSend = async () => {
        if ((!input.trim() && attachments.length === 0) || !proxyStatus?.running) return;

        const currentAttachments = [...attachments]; // Capture current attachments
        
        // Separate images and file content
        const attachedImages = currentAttachments
            .filter(a => a.type === 'image')
            .map(a => a.content);

        const attachedFiles = currentAttachments
            .filter(a => a.type === 'file');

        // Construct message content
        let finalContent = input.trim();

        // Append file contents to the message
        if (attachedFiles.length > 0) {
            const fileContext = attachedFiles.map(f => 
                `\n\n--- File: ${f.name} ---\n${f.content}\n--- End of File ${f.name} ---`
            ).join('\n');
            
            finalContent += fileContext;
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

    // Helper to render message content with basic markdown image support and file collapsing
    const renderMessageContent = (content: string) => {
        // 1. First split by file blocks
        // Regex to capture the whole block: --- File: name ---\ncontent\n--- End of File name ---
        const fileBlockRegex = /(--- File: .*? ---\n[\s\S]*?\n--- End of File .*? ---)/g;
        
        const fileParts = content.split(fileBlockRegex);
        
        return fileParts.map((part, i) => {
            // Check if this part is a file block
            const fileMatch = part.match(/--- File: (.*?) ---\n([\s\S]*?)\n--- End of File \1 ---/);
            
            if (fileMatch) {
                const fileName = fileMatch[1];
                const fileContent = fileMatch[2];
                return (
                    <details key={i} className="my-2 border border-base-300 rounded-lg bg-base-100 dark:bg-base-300 overflow-hidden">
                        <summary className="px-3 py-2 cursor-pointer hover:bg-base-200 dark:hover:bg-base-200/50 text-xs font-semibold flex items-center gap-2 select-none">
                            <FileIcon size={14} className="opacity-70" />
                            <span>File: {fileName}</span>
                            <span className="ml-auto opacity-50 text-[10px]">{fileContent.length} chars</span>
                        </summary>
                        <div className="p-3 bg-base-200/50 dark:bg-base-300/50 border-t border-base-300 overflow-x-auto">
                            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                                {fileContent}
                            </pre>
                        </div>
                    </details>
                );
            }

            // 2. If not a file block, process as Markdown

            // Enhanced: Unwrap images from code blocks and detect raw base64
            let markdownContent = part;

            // Strategy 1: Remove code blocks wrapping images using specific replacement callback
            // Find any code block
            markdownContent = markdownContent.replace(/```(?:[\w-]*\n)?([\s\S]*?)```/g, (match, contentInside) => {
                // If the content inside specifically looks like an image or file link, unwrap it.
                // We check for ![...](...) pattern.
                if (contentInside.trim().match(/^!\[[\s\S]*?\]\([\s\S]*?\)$/)) {
                    return contentInside.trim();
                }
                return match; // Keep as code block if it's just code
            });
            
            // Strategy 2: Handle indented code blocks (4 spaces or tab) for images
            // If the content is indented but is just an image
            if (markdownContent.match(/^(\s{4,}|\t)!\[[\s\S]*?\]\([\s\S]*?\)$/s)) {
                 markdownContent = markdownContent.trim();
            }

            // Strategy 3: Setup for raw base64 detection (if model returns just base64 string)
            // Use a heuristic: if it starts with data:image and is long, wrap it in an image tag
            if (markdownContent.trim().match(/^data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+$/)) {
                markdownContent = `![Generated Image](${markdownContent.trim()})`;
            }
            
            // Strategy 4: Fallback - if we successfully unwrapped into ![...](...), ReactMarkdown will handle it.
            // But if there are "broken" images due to weird characters in base64 inside markdown, we might need more processing.
            // keeping it simple for now.

            return (
                <div key={i} className="prose prose-sm dark:prose-invert max-w-none break-words">
                    <ReactMarkdown 
                        remarkPlugins={[remarkGfm]}
                        components={{
                            img: ({node, ...props}) => (
                                <img 
                                    {...props} 
                                    className="max-w-full h-auto rounded-lg my-2 border border-base-300 mx-auto cursor-pointer hover:opacity-90 transition-opacity"
                                    onClick={() => window.open(props.src, '_blank')}
                                />
                            ),
                            a: ({node, ...props}) => (
                                <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />
                            ),
                            pre: ({node, ...props}) => (
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
        >

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
                                "flex gap-4 max-w-[96%] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300",
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
                                    
                                    {/* Copy Button for Assistant */}
                                    {msg.role === 'assistant' && msg.status !== 'streaming' && (
                                        <div className="flex justify-end mt-2 pt-2 border-t border-base-content/10">
                                            <CopyButton content={msg.content} />
                                        </div>
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
                <div className="max-w-[96%] mx-auto relative group">
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
                            {attachments.map((att, idx) => (
                                <div key={att.id} className="relative group/preview flex-none">
                                    {att.type === 'image' ? (
                                        <img src={att.content} alt={att.name} className="w-16 h-16 object-cover rounded-lg border border-base-300" />
                                    ) : (
                                        <div className="w-16 h-16 flex flex-col items-center justify-center bg-base-200 rounded-lg border border-base-300 p-1">
                                            <FileIcon size={24} className="text-base-content/60 mb-1" />
                                            <span className="text-[8px] text-base-content/60 truncate w-full text-center">{att.name}</span>
                                        </div>
                                    )}
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
                            multiple 
                            onChange={handleFileSelect}
                        />
                        <button 
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isLoading}
                            className="btn btn-circle btn-sm btn-ghost text-base-content/50 hover:text-primary hover:bg-primary/10 transition-colors"
                            title={t('Attach File')}
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
            console.error('Failed to copy keys:', err);
            showToast(t('Failed to copy'), 'error');
        }
    };

    return (
        <button 
            onClick={handleCopy}
            className="btn btn-ghost btn-xs gap-1 text-base-content/50 hover:text-primary hover:bg-base-200"
            title={t('Copy content')}
        >
            {isCopied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
            <span className="text-[10px] uppercase font-bold tracking-wider">{isCopied ? t('Copied') : t('Copy')}</span>
        </button>
    );
}

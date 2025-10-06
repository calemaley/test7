import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  MessageCircle,
  X,
  Minus,
  Send,
  Info,
  Phone,
  BookOpenCheck,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { companyInfo } from "@/data/company-info";
import {
  appendChatbotMessage,
  createChatbotSession,
  getChatbotSession,
  updateChatbotSession,
  type ChatbotActionLog,
  type ChatbotMessage,
  type ChatbotSession,
} from "@/lib/chatbot";
import { saveSubmission } from "@/lib/submissions";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { chatWithAI, type AiMessage } from "@/lib/ai";
import { useNavigate } from "react-router-dom";

const SESSION_STORAGE_KEY = "jbranky:chatbot:session";
const DEFAULT_QUICK_ACTIONS: QuickReply[] = [
  {
    id: "services",
    label: "Explore services",
    payload: { type: "knowledge", topic: "services" },
  },
  {
    id: "service-request",
    label: "Request a service",
    payload: { type: "start_submission", submissionType: "service" },
  },
  {
    id: "consultation",
    label: "Book consultation",
    payload: { type: "start_submission", submissionType: "consultation" },
  },
  {
    id: "callback",
    label: "Request call back",
    payload: { type: "start_submission", submissionType: "callback" },
  },
  {
    id: "general",
    label: "General question",
    payload: { type: "start_submission", submissionType: "general" },
  },
];

type ChatPhase = "tutorial" | "lead" | "chat";
type SubmissionFlow = null | {
  type: "service" | "consultation" | "callback" | "general";
  serviceId?: string;
};

type QuickReply = {
  id: string;
  label: string;
  payload:
    | {
        type: "knowledge";
        topic: "services" | "contact" | "faq";
        extra?: string;
      }
    | { type: "service_detail"; serviceId: string }
    | { type: "start_submission"; submissionType: SubmissionFlow["type"] }
    | { type: "select_service"; serviceId: string }
    | { type: "link"; href: string; label: string }
    | { type: "reset" };
};

function resolveQuickReplyActionType(
  reply: QuickReply,
): ChatbotActionLog["type"] {
  const payload = reply.payload;
  switch (payload.type) {
    case "start_submission":
      return payload.submissionType ?? "general";
    case "service_detail":
    case "select_service":
      return "service";
    case "knowledge":
      return payload.topic === "services" ? "service" : "general";
    default:
      return "general";
  }
}

type DraftLead = {
  name: string;
  email: string;
  phone: string;
};

function persistSessionId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    else sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore persistence errors
  }
}

function retrieveSessionId() {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

const BOT_INTENTS = {
  SERVICES_OVERVIEW: "services_overview",
  SERVICE_DETAIL: "service_detail",
  CONTACT: "contact_info",
  CALLBACK: "callback_request",
  CONSULTATION: "consultation_booking",
  GENERAL: "general_inquiry",
  TUTORIAL: "tutorial",
  WELCOME: "welcome",
  THANK_YOU: "thank_you",
} as const;

type BotIntent = (typeof BOT_INTENTS)[keyof typeof BOT_INTENTS];

function createLocalMessage(
  sender: ChatbotMessage["sender"],
  content: string,
  intent?: BotIntent | null,
): ChatbotMessage {
  return {
    id: crypto.randomUUID(),
    sender,
    content,
    createdAt: new Date().toISOString(),
    intent: intent ?? null,
  };
}

function getServiceByKeyword(text: string) {
  const lowered = text.toLowerCase();
  return companyInfo.services.find((service) => {
    if (lowered.includes(service.id)) return true;
    const slug = service.title.toLowerCase();
    if (lowered.includes(slug)) return true;
    if (service.id === "medium-voltage") {
      return (
        lowered.includes("medium voltage") || lowered.includes("medium-voltage")
      );
    }
    if (service.id === "sollatek") {
      return lowered.includes("sollatek") || lowered.includes("protection");
    }
    if (service.id === "hydropower") {
      return lowered.includes("hydro") || lowered.includes("plant");
    }
    return false;
  });
}

function formatServiceDetails(serviceId: string) {
  const service = companyInfo.services.find((item) => item.id === serviceId);
  if (!service) return null;
  const highlightList = service.highlights
    .map((item) => `• ${item}`)
    .join("\n");
  return {
    heading: `${service.title}`,
    body: `${service.shortDescription}\n${highlightList}\n\nExplore more: ${service.route}`,
  };
}

export default function JbrankyChatbot() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<ChatPhase>("tutorial");
  const [tutorialIndex, setTutorialIndex] = useState(0);
  const [leadDraft, setLeadDraft] = useState<DraftLead>({
    name: "",
    email: "",
    phone: "",
  });
  const [leadErrors, setLeadErrors] = useState<Record<keyof DraftLead, string>>(
    {
      name: "",
      email: "",
      phone: "",
    },
  );
  const [session, setSession] = useState<ChatbotSession | null>(null);
  const [messages, setMessages] = useState<ChatbotMessage[]>([]);
  const [isOpen, setIsOpen] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [processing, setProcessing] = useState(false);
  const [submissionFlow, setSubmissionFlow] = useState<SubmissionFlow>(null);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>(
    DEFAULT_QUICK_ACTIONS,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const storedId = retrieveSessionId();
    if (!storedId) {
      setPhase("tutorial");
      setIsOpen(true);
      return;
    }

    (async () => {
      try {
        const existing = await getChatbotSession(storedId);
        setSession(existing);
        setMessages(existing.messages);
        setPhase("chat");
        setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
      } catch {
        persistSessionId(null);
        setPhase("tutorial");
      }
    })();
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setIsCollapsed(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  useEffect(() => {
    const timer = setTimeout(() => setIsOpen(true), 600);
    return () => clearTimeout(timer);
  }, []);

  const tutorialSteps = companyInfo.tutorial;
  const currentTutorial = tutorialSteps[tutorialIndex];

  const leadFormValid = useMemo(() => {
    return (
      leadDraft.name.trim().length >= 2 &&
      /@/.test(leadDraft.email.trim()) &&
      leadDraft.phone.trim().length >= 7
    );
  }, [leadDraft]);

  const handleTutorialNext = async (action: "next" | "skip") => {
    if (action === "skip" || tutorialIndex === tutorialSteps.length - 1) {
      setPhase("lead");
      setTutorialIndex(tutorialSteps.length - 1);
      if (session) {
        await updateChatbotSession(session.id, {
          metadata: { tutorialCompleted: true },
        });
      }
      return;
    }
    setTutorialIndex((prev) => Math.min(prev + 1, tutorialSteps.length - 1));
  };

  const handleLeadChange = (field: keyof DraftLead, value: string) => {
    setLeadDraft((prev) => ({ ...prev, [field]: value }));
    setLeadErrors((prev) => ({ ...prev, [field]: "" }));
  };

  const validateLead = () => {
    const errors: Record<keyof DraftLead, string> = {
      name: "",
      email: "",
      phone: "",
    };
    if (leadDraft.name.trim().length < 2) {
      errors.name = "Please share your full name.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadDraft.email.trim())) {
      errors.email = "Enter a valid email address.";
    }
    if (leadDraft.phone.trim().length < 7) {
      errors.phone = "Add a phone number we can reach you on.";
    }
    setLeadErrors(errors);
    return !errors.name && !errors.email && !errors.phone;
  };

  const startSession = async () => {
    if (!validateLead()) return;
    try {
      const payload = {
        visitorName: leadDraft.name.trim(),
        visitorEmail: leadDraft.email.trim(),
        visitorPhone: leadDraft.phone.trim(),
        originPath: window.location.pathname,
        metadata: { tutorialCompleted: phase !== "tutorial" },
      };
      const newSession = await createChatbotSession(payload);
      persistSessionId(newSession.id);
      setSession(newSession);
      setPhase("chat");
      setMessages([]);
      await sendBotIntro(newSession, payload.visitorName);
      setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to start chat session.",
      );
    }
  };

  const refreshSessionMessages = async (sessionId: string) => {
    try {
      const updated = await getChatbotSession(sessionId);
      setSession(updated);
      setMessages(updated.messages);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to refresh chatbot history.",
      );
    }
  };

  const pushMessage = async (
    sender: ChatbotMessage["sender"],
    content: string,
    intent?: BotIntent,
    { skipPersist = false }: { skipPersist?: boolean } = {},
  ) => {
    const message = createLocalMessage(sender, content, intent);
    setMessages((prev) => [...prev, message]);
    if (!session || skipPersist) return message;
    try {
      await appendChatbotMessage(session.id, {
        sender,
        content,
        intent,
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to sync chatbot message.",
      );
    }
    return message;
  };

  const sendBotIntro = async (activeSession: ChatbotSession, name: string) => {
    await pushMessage(
      "bot",
      `Hi ${name}, I'm ${companyInfo.botName}. I'm here to guide you through ${companyInfo.companyName}.` +
        "\n" +
        companyInfo.tagline,
      BOT_INTENTS.WELCOME,
      { skipPersist: false },
    );
    await pushMessage(
      "bot",
      `You can ask about our services, request a call back, or book a consultation. I can also connect you to our specialists on ${companyInfo.contact.phone}.`,
      BOT_INTENTS.SERVICES_OVERVIEW,
      { skipPersist: false },
    );
    await updateChatbotSession(activeSession.id, {
      metadata: { tutorialCompleted: true },
    });
  };

  const handleQuickReply = async (reply: QuickReply) => {
    setQuickReplies((prev) => prev.filter((item) => item.id !== reply.id));
    const payload = reply.payload;
    switch (payload.type) {
      case "knowledge": {
        if (payload.topic === "services") {
          const overview = companyInfo.services
            .map(
              (service) =>
                `${service.title}: ${service.shortDescription}\n• ${service.highlights[0]}\n• ${service.highlights[1]}`,
            )
            .join("\n\n");
          await pushMessage("bot", overview, BOT_INTENTS.SERVICES_OVERVIEW);
          setQuickReplies((prev) => [
            ...prev,
            ...companyInfo.services.map<QuickReply>((service) => ({
              id: `detail-${service.id}`,
              label: service.title,
              payload: { type: "service_detail", serviceId: service.id },
            })),
            {
              id: "contact-info",
              label: "How do I reach you?",
              payload: { type: "knowledge", topic: "contact" },
            },
            {
              id: "reset-actions",
              label: "Show quick actions",
              payload: { type: "reset" },
            },
          ]);
        }
        if (payload.topic === "contact") {
          await pushMessage(
            "bot",
            `You can reach us on ${companyInfo.contact.phone} or ${companyInfo.contact.email}. ${companyInfo.contact.responseTime}`,
            BOT_INTENTS.CONTACT,
          );
          setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
        }
        break;
      }
      case "service_detail": {
        if (payload.type !== "service_detail") break;
        const details = formatServiceDetails(payload.serviceId);
        if (details) {
          await pushMessage(
            "bot",
            `${details.heading}\n${details.body}`,
            BOT_INTENTS.SERVICE_DETAIL,
          );
          setQuickReplies((prev) => [
            ...DEFAULT_QUICK_ACTIONS.map((item) => ({ ...item })),
            {
              id: `request-${payload.serviceId}`,
              label: `Request ${details.heading}`,
              payload: {
                type: "start_submission",
                submissionType: "service",
              },
            },
          ]);
        }
        break;
      }
      case "start_submission": {
        if (payload.type !== "start_submission") break;
        const type = payload.submissionType;
        setSubmissionFlow({ type });
        if (type === "service") {
          await pushMessage(
            "bot",
            "Great! Which service are you interested in? Choose one below or type the name.",
            BOT_INTENTS.SERVICE_DETAIL,
          );
          setQuickReplies(
            companyInfo.services.map((service) => ({
              id: `select-${service.id}`,
              label: service.title,
              payload: { type: "select_service", serviceId: service.id },
            })),
          );
        } else if (type === "consultation") {
          await updateChatbotSession(session!.id, {
            metadata: { bookedConsultation: true },
            lastIntent: BOT_INTENTS.CONSULTATION,
          });
          const q = new URLSearchParams({
            type: "consultation",
            name: session!.visitorName,
            email: session!.visitorEmail,
            phone: session!.visitorPhone,
          });
          navigate(`/contact?${q.toString()}`);
          await pushMessage(
            "bot",
            "Opening consultation form. I’ve pre-filled your details.",
            BOT_INTENTS.CONSULTATION,
          );
          setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
        } else {
          await pushMessage(
            "bot",
            "Please share a short description so I can alert the right specialist.",
            type === "callback" ? BOT_INTENTS.CALLBACK : BOT_INTENTS.GENERAL,
          );
        }
        break;
      }
      case "select_service": {
        if (payload.type !== "select_service") break;
        setSubmissionFlow({ type: "service", serviceId: payload.serviceId });
        const details = formatServiceDetails(payload.serviceId);
        if (details) {
          await pushMessage(
            "bot",
            `Noted: ${details.heading}. Could you describe your project or needs so we prepare the right response?`,
            BOT_INTENTS.SERVICE_DETAIL,
          );
        } else {
          await pushMessage(
            "bot",
            "Noted. Please describe your project requirements.",
            BOT_INTENTS.SERVICE_DETAIL,
          );
        }
        break;
      }
      case "reset": {
        setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
        setSubmissionFlow(null);
        break;
      }
      case "link": {
        if (payload.type === "link") {
          window.open(payload.href, "_blank", "noopener");
        }
        break;
      }
      default:
        break;
    }
  };

  const detectIntentFromMessage = (text: string): BotIntent => {
    const lowered = text.toLowerCase();
    if (lowered.includes("call") && lowered.includes("back")) {
      return BOT_INTENTS.CALLBACK;
    }
    if (lowered.includes("consult")) {
      return BOT_INTENTS.CONSULTATION;
    }
    if (lowered.includes("thank")) {
      return BOT_INTENTS.THANK_YOU;
    }
    const service = getServiceByKeyword(lowered);
    if (service) {
      return BOT_INTENTS.SERVICE_DETAIL;
    }
    if (lowered.includes("phone") || lowered.includes("contact")) {
      return BOT_INTENTS.CONTACT;
    }
    return BOT_INTENTS.GENERAL;
  };

  const handleSubmission = async (flow: SubmissionFlow, details: string) => {
    if (!flow || !session) return;
    const payload = {
      name: session.visitorName,
      email: session.visitorEmail,
      phone: session.visitorPhone,
      type:
        flow.type === "service"
          ? "Service chatbot"
          : flow.type === "consultation"
            ? "Consultation chatbot"
            : flow.type === "callback"
              ? "Call back chatbot"
              : "General chatbot",
      service:
        flow.type === "service"
          ? (flow.serviceId ?? "unspecified")
          : flow.type === "consultation"
            ? "consultation"
            : null,
      message: details.trim(),
    } as const;

    try {
      await saveSubmission(payload);
      try {
        await updateChatbotSession(session.id, {
          metadata: {
            bookedConsultation: flow.type === "consultation" ? true : undefined,
            requestedCallback: flow.type === "callback" ? true : undefined,
            requestedService:
              flow.type === "service" ? (flow.serviceId ?? null) : undefined,
          },
          lastIntent:
            flow.type === "service"
              ? BOT_INTENTS.SERVICE_DETAIL
              : flow.type === "consultation"
                ? BOT_INTENTS.CONSULTATION
                : flow.type === "callback"
                  ? BOT_INTENTS.CALLBACK
                  : BOT_INTENTS.GENERAL,
        });
      } catch {}
      await pushMessage(
        "bot",
        "Thanks! I've logged this for our team. Expect a response within one business day.",
        BOT_INTENTS.THANK_YOU,
      );
      setSubmissionFlow(null);
      setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to capture your request. Please try again.",
      );
    }
  };

  const handleVisitorMessage = async (raw: string) => {
    if (!session) {
      toast.error("Please provide your details first.");
      return;
    }
    const text = raw.trim();
    if (!text) return;
    setProcessing(true);
    try {
      const intent = detectIntentFromMessage(text);
      await pushMessage("visitor", text, intent);

      if (submissionFlow) {
        await handleSubmission(submissionFlow, text);
        setProcessing(false);
        return;
      }

      const service = getServiceByKeyword(text);
      if (service) {
        const details = formatServiceDetails(service.id);
        if (details) {
          await pushMessage(
            "bot",
            `${details.heading}\n${details.body}`,
            BOT_INTENTS.SERVICE_DETAIL,
          );
          setQuickReplies((prev) => [
            ...DEFAULT_QUICK_ACTIONS.map((item) => ({ ...item })),
            {
              id: `service-${service.id}-request`,
              label: `Request ${service.title}`,
              payload: {
                type: "start_submission",
                submissionType: "service",
              },
            },
          ]);
          setProcessing(false);
          return;
        }
      }

      if (intent === BOT_INTENTS.CALLBACK) {
        setSubmissionFlow({ type: "callback" });
        if (session) {
          await updateChatbotSession(session.id, {
            metadata: { requestedCallback: true },
            lastIntent: BOT_INTENTS.CALLBACK,
          });
        }
        await pushMessage(
          "bot",
          "Absolutely. Tell me the best time or any context so the right engineer calls you back.",
          BOT_INTENTS.CALLBACK,
        );
        setProcessing(false);
        return;
      }

      if (intent === BOT_INTENTS.CONSULTATION) {
        setSubmissionFlow({ type: "consultation" });
        await pushMessage(
          "bot",
          "Happy to schedule a consultation. Let me know the scope or questions you have, and I'll line up the right specialist.",
          BOT_INTENTS.CONSULTATION,
        );
        setProcessing(false);
        return;
      }

      if (intent === BOT_INTENTS.CONTACT) {
        await pushMessage(
          "bot",
          `You can reach us directly on ${companyInfo.contact.phone}, email ${companyInfo.contact.email}, or request a call back here.`,
          BOT_INTENTS.CONTACT,
        );
        setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
        setProcessing(false);
        return;
      }

      const matchedArticle = companyInfo.knowledgeBase.find((article) =>
        article.tags.some((tag) => text.toLowerCase().includes(tag)),
      );
      if (matchedArticle) {
        await pushMessage("bot", matchedArticle.answer, BOT_INTENTS.GENERAL);
        setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
        setProcessing(false);
        return;
      }

      // AI fallback if configured on the server
      try {
        const history: AiMessage[] = [
          {
            role: "system",
            content:
              `You are ${companyInfo.botName}, a helpful assistant for ${companyInfo.companyName}. Be concise, friendly, and grounded in the following services: ` +
              companyInfo.services.map((s) => s.title).join(", ") +
              `. Only answer relevant to the company context. If unsure, suggest contacting ${companyInfo.contact.phone} or ${companyInfo.contact.email}.`,
          },
          ...messages.slice(-8).map<AiMessage>((m) => ({
            role: m.sender === "visitor" ? "user" : "assistant",
            content: m.content,
          })),
          { role: "user", content: text },
        ];

        const ai = await chatWithAI(history).catch(() => null);
        if (ai?.content && ai.content.trim()) {
          await pushMessage("bot", ai.content.trim(), BOT_INTENTS.GENERAL);
          setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
          setProcessing(false);
          return;
        }
      } catch {
        // ignore AI errors and fall back
      }

      await pushMessage(
        "bot",
        `Here's what I can help with:\n• Service details for hydropower, medium-voltage, and Sollatek solutions\n• Booking consultations or site surveys\n• Sharing company contacts and response times\n• Capturing project requirements for our engineers.\nIf you'd like a human to call you, just let me know!`,
        BOT_INTENTS.GENERAL,
      );
      setQuickReplies([...DEFAULT_QUICK_ACTIONS]);
    } finally {
      setProcessing(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inputValue.trim() || processing) return;
    const value = inputValue;
    setInputValue("");
    await handleVisitorMessage(value);
  };

  const renderMessages = () => (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto pr-1 overscroll-contain -mr-1"
      style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
    >
      <div className="space-y-3">
        {messages.map((message) => (
          <ChatBubble key={message.id} message={message} />
        ))}
        {phase === "chat" && messages.length === 0 && (
          <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground">
            Say hello or pick a quick action to get started.
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-x-3 md:inset-auto right-4 z-[70] flex flex-col items-end space-y-3"
      style={{ bottom: "calc(1rem + env(safe-area-inset-bottom))" }}
    >
      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="chatbot"
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="w-full md:w-[360px] max-w-[calc(100vw-1.5rem)] md:max-w-[92vw] overflow-hidden rounded-t-2xl md:rounded-2xl border border-primary/20 bg-white shadow-2xl"
          >
            <header className="sticky top-0 z-10 flex items-start justify-between bg-gradient-to-r from-primary to-secondary px-4 py-3 text-white">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-white/90">
                  <Sparkles className="h-4 w-4" /> {companyInfo.botName}
                </div>
                <p className="text-xs text-white/80">
                  {phase === "tutorial"
                    ? "Let me walk you through the site."
                    : "Ask about services, pricing, or request a call back."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-white/80 hover:bg-white/20"
                  onClick={() => setIsCollapsed((prev) => !prev)}
                >
                  {isCollapsed ? (
                    <MessageCircle className="h-4 w-4" />
                  ) : (
                    <Minus className="h-4 w-4" />
                  )}
                  <span className="sr-only">Toggle chat visibility</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-white/80 hover:bg-white/20"
                  onClick={() => setIsOpen(false)}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close chatbot</span>
                </Button>
              </div>
            </header>

            {!isCollapsed && (
              <div className="flex h-[65vh] sm:h-[520px] md:h-[560px] flex-col bg-white min-h-0">
                {phase === "tutorial" && (
                  <div className="flex flex-1 flex-col gap-4 p-4 min-h-0">
                    <div className="rounded-xl bg-primary/5 p-4">
                      <div className="mb-2 flex items-center gap-2 text-primary">
                        <Info className="h-4 w-4" />
                        <span className="text-sm font-semibold uppercase tracking-wide">
                          Step {tutorialIndex + 1} of {tutorialSteps.length}
                        </span>
                      </div>
                      <h3 className="font-display text-lg font-bold text-primary">
                        {currentTutorial?.title}
                      </h3>
                      <p className="mt-1 text-sm text-foreground/70">
                        {currentTutorial?.description}
                      </p>
                    </div>
                    <div className="mt-auto grid grid-cols-2 gap-3">
                      <Button
                        variant="outline"
                        onClick={() => handleTutorialNext("skip")}
                      >
                        Skip tutorial
                      </Button>
                      <Button onClick={() => handleTutorialNext("next")}>
                        {tutorialIndex === tutorialSteps.length - 1
                          ? "Start chatting"
                          : "Next"}
                      </Button>
                    </div>
                  </div>
                )}

                {phase === "lead" && (
                  <div className="flex flex-1 flex-col gap-3 p-4 min-h-0">
                    <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
                      Before we begin, could you share your contact details?
                      We'll use them to follow up with tailored advice.
                    </div>
                    <Input
                      placeholder="Full name"
                      value={leadDraft.name}
                      onChange={(event) =>
                        handleLeadChange("name", event.target.value)
                      }
                    />
                    {leadErrors.name && (
                      <p className="text-xs text-destructive">
                        {leadErrors.name}
                      </p>
                    )}
                    <Input
                      placeholder="Email"
                      type="email"
                      value={leadDraft.email}
                      onChange={(event) =>
                        handleLeadChange("email", event.target.value)
                      }
                    />
                    {leadErrors.email && (
                      <p className="text-xs text-destructive">
                        {leadErrors.email}
                      </p>
                    )}
                    <Input
                      placeholder="Phone"
                      value={leadDraft.phone}
                      onChange={(event) =>
                        handleLeadChange("phone", event.target.value)
                      }
                    />
                    {leadErrors.phone && (
                      <p className="text-xs text-destructive">
                        {leadErrors.phone}
                      </p>
                    )}
                    <div className="mt-auto flex flex-col gap-2">
                      <Button onClick={startSession} disabled={!leadFormValid}>
                        Start chatting
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        We'll keep your session so our admin team can follow the
                        conversation in the dashboard.
                      </p>
                    </div>
                  </div>
                )}

                {phase === "chat" && (
                  <div className="flex flex-1 flex-col gap-3 p-4 min-h-0">
                    {renderMessages()}
                    {quickReplies.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {quickReplies.map((reply) => (
                          <Button
                            key={reply.id}
                            variant="outline"
                            size="sm"
                            className="rounded-full border-primary/30 text-xs text-primary hover:bg-primary/10"
                            onClick={() => handleQuickReply(reply)}
                          >
                            {reply.label}
                          </Button>
                        ))}
                      </div>
                    )}
                    <form
                      onSubmit={handleSubmit}
                      className="sticky bottom-0 left-0 right-0 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80 border-t pt-2 mt-auto flex items-end gap-2"
                    >
                      <Textarea
                        value={inputValue}
                        onChange={(event) => setInputValue(event.target.value)}
                        placeholder="Type your message..."
                        rows={2}
                        className="resize-none rounded-xl border-primary/20 pr-10 text-sm"
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (!processing) {
                              void handleSubmit(
                                event as unknown as React.FormEvent,
                              );
                            }
                          }
                        }}
                      />
                      <Button
                        type="submit"
                        size="icon"
                        disabled={processing || !inputValue.trim()}
                      >
                        <Send className="h-4 w-4" />
                        <span className="sr-only">Send message</span>
                      </Button>
                    </form>
                    {processing && (
                      <p className="text-[11px] text-muted-foreground">
                        Thinking...
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {!isOpen && (
        <>
          <Button
            className="md:hidden h-12 w-12 rounded-full bg-primary text-white shadow-lg shadow-primary/30"
            size="icon"
            onClick={() => setIsOpen(true)}
            aria-label="Open chat"
          >
            <MessageCircle className="h-5 w-5" />
          </Button>
          <Button
            className="hidden md:inline-flex relative items-center gap-2 rounded-full bg-primary px-4 py-2 text-white shadow-lg shadow-primary/30"
            onClick={() => setIsOpen(true)}
          >
            <MessageCircle className="h-4 w-4" /> Chat with{" "}
            {companyInfo.botName}
          </Button>
        </>
      )}
    </div>
  );
}

type ChatBubbleProps = {
  message: ChatbotMessage;
};

function ChatBubble({ message }: ChatBubbleProps) {
  const isVisitor = message.sender === "visitor";
  const isBot = message.sender === "bot";
  const icon = isBot ? (
    <Sparkles className="h-4 w-4 text-secondary" />
  ) : message.sender === "visitor" ? (
    <BookOpenCheck className="h-4 w-4 text-primary" />
  ) : (
    <Info className="h-4 w-4 text-muted-foreground" />
  );

  return (
    <div
      className={cn(
        "flex gap-2",
        isVisitor ? "justify-end text-right" : "justify-start text-left",
      )}
    >
      {!isVisitor && (
        <div className="mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          {icon}
        </div>
      )}
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm",
          isVisitor
            ? "bg-primary text-white ml-auto"
            : "bg-muted/50 text-foreground",
        )}
      >
        {message.content.split("\n").map((line, idx) => (
          <p key={idx} className="whitespace-pre-wrap">
            {line}
          </p>
        ))}
        <p
          className={cn(
            "mt-2 text-[10px] uppercase tracking-wide",
            isVisitor ? "text-white/70" : "text-foreground/60",
          )}
        >
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
      {isVisitor && (
        <div className="mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          <Phone className="h-4 w-4 text-primary" />
        </div>
      )}
    </div>
  );
}

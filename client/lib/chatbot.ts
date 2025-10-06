export type ChatbotSender = "visitor" | "bot" | "system";

export type ChatbotActionLog = {
  type: "consultation" | "callback" | "service" | "general";
  at: string;
  payload?: Record<string, unknown>;
};

export interface ChatbotMessage {
  id: string;
  sender: ChatbotSender;
  content: string;
  createdAt: string;
  intent?: string | null;
}

export interface ChatbotSession {
  id: string;
  visitorName: string;
  visitorEmail: string;
  visitorPhone: string;
  originPath?: string;
  createdAt: string;
  updatedAt: string;
  lastIntent?: string | null;
  metadata: {
    tutorialCompleted: boolean;
    leadCaptured: boolean;
    requestedCallback?: boolean;
    bookedConsultation?: boolean;
    requestedService?: string | null;
    actions?: ChatbotActionLog[];
  };
  messages: ChatbotMessage[];
}

const BASE_PATH = "/api/chatbot-sessions";

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText || "Request failed";
    try {
      const data = await response.json();
      if (typeof data === "string") detail = data;
      else if (data?.detail) detail = data.detail;
      else detail = JSON.stringify(data);
    } catch {
      // swallow json errors
    }
    throw new Error(detail);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function request<T>(input: string, init?: RequestInit) {
  const res = await fetch(`${BASE_PATH}${input}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  return handleResponse<T>(res);
}

export interface CreateChatbotSessionPayload {
  visitorName: string;
  visitorEmail: string;
  visitorPhone: string;
  originPath?: string;
  metadata?: Partial<ChatbotSession["metadata"]>;
}

export async function createChatbotSession(
  payload: CreateChatbotSessionPayload,
): Promise<ChatbotSession> {
  return request<ChatbotSession>("", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export interface AppendChatbotMessagePayload {
  sender: ChatbotSender;
  content: string;
  intent?: string | null;
}

export async function appendChatbotMessage(
  sessionId: string,
  payload: AppendChatbotMessagePayload,
): Promise<ChatbotMessage> {
  return request<ChatbotMessage>(`/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getChatbotSession(
  sessionId: string,
): Promise<ChatbotSession> {
  return request<ChatbotSession>(`/${sessionId}`, { method: "GET" });
}

export async function updateChatbotSession(
  sessionId: string,
  payload: Partial<
    Omit<
      ChatbotSession,
      "id" | "messages" | "createdAt" | "updatedAt" | "metadata"
    >
  > & {
    metadata?: Partial<ChatbotSession["metadata"]>;
  },
): Promise<ChatbotSession> {
  return request<ChatbotSession>(`/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listChatbotSessions(): Promise<ChatbotSession[]> {
  return request<ChatbotSession[]>("", { method: "GET" });
}

import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  createProvider,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Credential,
  type CredentialStore,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

type AuthStorageCredential = ReturnType<AuthStorage["get"]>;

class AuthStorageCredentialStore implements CredentialStore {
  constructor(private readonly authStorage: AuthStorage) {}

  read(providerId: string): Promise<Credential | undefined> {
    return Promise.resolve(toPiCredential(this.authStorage.get(providerId)));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const nextCredential = await fn(await this.read(providerId));
    if (nextCredential !== undefined) {
      const storableCredential = toAuthStorageCredential(nextCredential);
      if (storableCredential !== undefined) {
        this.authStorage.set(providerId, storableCredential);
      }
      return nextCredential;
    }
    return this.read(providerId);
  }

  delete(providerId: string): Promise<void> {
    this.authStorage.remove(providerId);
    return Promise.resolve();
  }
}

const defaultCredentialStore = new AuthStorageCredentialStore(AuthStorage.create());
const requestProviders = new Map<string, Provider>();

export function credentialStoreFromAuthStorage(authStorage: AuthStorage): CredentialStore {
  return new AuthStorageCredentialStore(authStorage);
}

export function registerPiAiProvider(provider: Provider): () => void {
  requestProviders.set(provider.id, provider);
  return () => {
    if (requestProviders.get(provider.id) === provider) {
      requestProviders.delete(provider.id);
    }
  };
}

export function streamModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ApiStreamOptions<TApi>,
): AssistantMessageEventStream {
  return modelsForRequest(model).stream(model, context, options);
}

export function completeModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
  return modelsForRequest(model).complete(model, context, options);
}

export function completeSimpleModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return modelsForRequest(model).completeSimple(model, context, options);
}

function modelsForRequest(model: Model<Api>) {
  const models = builtinModels({ credentials: defaultCredentialStore });
  const registeredProvider = requestProviders.get(model.provider);
  if (registeredProvider !== undefined) {
    models.setProvider(registeredProvider);
  } else if (models.getProvider(model.provider) === undefined) {
    models.setProvider(createRequestProvider(model));
  }
  return models;
}

function createRequestProvider(model: Model<Api>): Provider {
  return createProvider({
    id: model.provider,
    name: model.provider,
    baseUrl: model.baseUrl,
    headers: model.headers,
    models: [model],
    api: providerStreamsForApi(model.api),
    auth: {
      apiKey: {
        name: `${model.provider} API key`,
        resolve: ({ model: requestModel, credential }) =>
          Promise.resolve({
            auth: {
              apiKey: credential?.key,
              baseUrl: requestModel.baseUrl,
              headers: requestModel.headers,
            },
            env: credential?.env,
            source: credential?.key === undefined ? undefined : "auth.json",
          }),
      },
    },
  });
}

function providerStreamsForApi(api: Api): ProviderStreams {
  switch (api) {
    case "anthropic-messages":
      return anthropicMessagesApi();
    case "azure-openai-responses":
      return azureOpenAIResponsesApi();
    case "bedrock-converse-stream":
      return bedrockConverseStreamApi();
    case "google-generative-ai":
      return googleGenerativeAIApi();
    case "google-vertex":
      return googleVertexApi();
    case "mistral-conversations":
      return mistralConversationsApi();
    case "openai-codex-responses":
      return openAICodexResponsesApi();
    case "openai-completions":
      return openAICompletionsApi();
    case "openai-responses":
      return openAIResponsesApi();
    default:
      throw new Error(`Unsupported model API: ${api}`);
  }
}

function toPiCredential(credential: AuthStorageCredential): Credential | undefined {
  if (credential === undefined) return undefined;
  if (credential.type === "api_key") return credential;
  return credential;
}

function toAuthStorageCredential(credential: Credential): AuthStorageCredential {
  if (credential.type === "api_key") {
    if (credential.key === undefined) return undefined;
    return { type: "api_key", key: credential.key, env: credential.env };
  }
  return credential;
}

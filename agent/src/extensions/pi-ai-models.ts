import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import {
  createProvider,
  createModels,
  InMemoryCredentialStore,
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";

const defaultModelRuntimePromise = ModelRuntime.create({ allowModelNetwork: false });
const requestProviders = new Map<string, Provider>();

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
  options?: ModelsApiStreamOptions<TApi>,
): AssistantMessageEventStream {
  return lazyStream(model, async () =>
    (await modelsForRequest(model)).stream(model, context, options),
  );
}

export function completeModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ModelsApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
  return streamModel(model, context, options).result();
}

export function completeSimpleModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ModelsSimpleStreamOptions,
): Promise<AssistantMessage> {
  return lazyStream(model, async () =>
    (await modelsForRequest(model)).streamSimple(model, context, options),
  ).result();
}

async function modelsForRequest(model: Model<Api>) {
  const registeredProvider = requestProviders.get(model.provider);
  if (registeredProvider !== undefined) {
    const models = createModels({ credentials: new InMemoryCredentialStore() });
    models.setProvider(registeredProvider);
    return models;
  }

  const modelRuntime = await defaultModelRuntimePromise;
  if (modelRuntime.getProvider(model.provider) !== undefined) {
    return modelRuntime;
  }

  const models = createModels({ credentials: new InMemoryCredentialStore() });
  models.setProvider(createRequestProvider(model));
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
        resolve: ({ credential }) =>
          Promise.resolve({
            auth: {
              apiKey: credential?.key,
              baseUrl: model.baseUrl,
              headers: model.headers,
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
    case "pi-messages":
      return piMessagesApi();
    default:
      throw new Error(`Unsupported model API: ${api}`);
  }
}

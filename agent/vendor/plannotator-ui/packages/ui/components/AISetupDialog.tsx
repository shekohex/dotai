import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { getProviderMeta } from './ProviderIcons';
import { saveAIProviderSettings, savePreferredModel, getAIProviderSettings } from '../utils/aiProvider';
import { markAISetupDone } from '../utils/aiSetup';

interface AIProviderModel {
  id: string;
  label: string;
  default?: boolean;
}

interface AIProvider {
  id: string;
  name: string;
  capabilities: Record<string, boolean>;
  models?: AIProviderModel[];
}

interface AISetupDialogProps {
  isOpen: boolean;
  providers: AIProvider[];
  onComplete: (providerId: string) => void;
}

export const AISetupDialog: React.FC<AISetupDialogProps> = ({
  isOpen,
  providers,
  onComplete,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preferredModels, setPreferredModels] = useState<Record<string, string>>(() =>
    getAIProviderSettings().preferredModels
  );

  if (!isOpen || providers.length === 0) return null;

  const effectiveId = selectedId ?? providers[0]?.id ?? null;

  const handleSelectProvider = (id: string) => {
    setSelectedId(id);
  };

  const handleModelChange = (providerId: string, modelId: string) => {
    savePreferredModel(providerId, modelId);
    setPreferredModels(prev => ({ ...prev, [providerId]: modelId }));
  };

  const handleDone = () => {
    if (!effectiveId) return;
    const settings = getAIProviderSettings();
    saveAIProviderSettings({ ...settings, providerId: effectiveId });
    markAISetupDone();
    onComplete(effectiveId);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/15">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
              </svg>
            </div>
            <h3 className="font-semibold text-base">AI-Assisted Code Review</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Ask questions about code changes inline or in a side chat. Select lines in a diff,
            click the sparkle, and get streaming answers with full diff context.
          </p>
        </div>

        {/* Provider grid */}
        <div className="p-4">
          <div className="text-xs text-muted-foreground mb-2">Choose your default provider</div>
          <div className="grid grid-cols-2 gap-2">
            {providers.map(p => {
              const meta = getProviderMeta(p.name);
              const Icon = meta.icon;
              const isSelected = effectiveId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelectProvider(p.id)}
                  className={`flex items-center gap-2.5 p-3 rounded-lg border transition-colors text-left ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
                  }`}
                >
                  <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center text-muted-foreground flex-shrink-0">
                    <Icon className="w-4.5 h-4.5" />
                  </div>
                  <span className="text-sm font-medium">{meta.label}</span>
                  {isSelected && (
                    <svg className="w-3.5 h-3.5 text-primary ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          {/* Model selector for selected provider */}
          {effectiveId && (() => {
            const provider = providers.find(p => p.id === effectiveId);
            const models = provider?.models ?? [];
            if (models.length <= 1) return null;
            const defaultModel = models.find(m => m.default) ?? models[0];
            const selectedModel = preferredModels[effectiveId] ?? defaultModel?.id ?? '';
            return (
              <div className="mt-3">
                <label className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Model</span>
                  <select
                    value={selectedModel}
                    onChange={(e) => handleModelChange(effectiveId, e.target.value)}
                    className="flex-1 text-xs bg-muted rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                  >
                    {models.map(m => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center gap-3">
          <p className="text-[10px] text-muted-foreground/70 flex-1">
            Providers are detected from installed CLI tools.
            You must be authenticated with each CLI independently.{' '}
            <a href="https://plannotator.ai/docs/guides/ai-features/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Learn more</a>
          </p>
          <button
            onClick={handleDone}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity flex-shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

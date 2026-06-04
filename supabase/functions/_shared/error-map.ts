// Shared error-code → user-facing Portuguese message map.
//
// Intent handlers (e.g. add-tenant) import this record and use it to translate
// Supabase/domain error codes into friendly messages before returning them to
// the workflow engine.

export const ERROR_MAP: Record<string, string> = {
  GOOGLE_REAUTH_REQUIRED:
    "Sua conexão com o Google Drive expirou. Reconecte sua conta Google nas configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
  GOOGLE_AUTH_FAILED:
    "Falha ao autenticar com o Google Drive. Tente novamente.",
  INVALID_CPF:
    "O CPF informado não é válido. Por favor, informe o CPF no formato XXX.XXX.XXX-XX.",
  PROPERTY_NOT_FOUND:
    "Imóvel não encontrado. Por favor, selecione um imóvel válido.",
  LANDLORD_NOT_FOUND:
    "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
  DRIVE_CREATE_FOLDER_FAILED:
    "Falha ao criar pasta no Google Drive. Tente novamente.",
  DRIVE_STAR_FAILED:
    "Falha ao destacar pasta do inquilino no Google Drive. Tente novamente.",
  DB_ERROR: "Erro ao salvar. Tente novamente.",
  TENANT_NOT_FOUND: "Inquilino não encontrado. Tente novamente.",
  MISSING_WHATSAPP:
    "O inquilino não possui número de WhatsApp cadastrado. Atualize o cadastro antes de enviar para assinatura.",
  AUTENTIQUE_SUBMISSION_FAILED:
    "Falha ao enviar para o Autentique. Tente novamente ou acesse os documentos diretamente.",
  NO_TEMPLATES_FOUND:
    "Nenhum template encontrado para este imóvel. Verifique os templates cadastrados.",
  DRIVE_COPY_FAILED:
    "Falha ao copiar template no Google Drive. Tente novamente.",
  DRIVE_UPDATE_FAILED:
    "Falha ao gravar documento no Google Drive. Tente novamente.",
  // generate-document endpoint codes
  INVALID_PLACEHOLDERS:
    "Os campos enviados são inválidos. Verifique o formato e tente novamente.",
  MISSING_REQUIRED_PLACEHOLDERS:
    "Campos obrigatórios estão ausentes. Preencha todos os campos obrigatórios e tente novamente.",
  UNKNOWN_PLACEHOLDER:
    "Um dos campos enviados não é reconhecido. Verifique os campos e tente novamente.",
  INVALID_USE_CASE:
    "Ocasião inválida para geração de documento. Use 'initial', 'renewal' ou 'termination'.",
  MISSING_PROPERTY_ID:
    "O imóvel não foi identificado. Por favor, selecione um imóvel válido.",
  MISSING_TENANT_ID:
    "O inquilino não foi identificado. Por favor, selecione um inquilino válido.",
  DRIVE_SEARCH_FAILED:
    "Falha ao verificar arquivos no Google Drive. Tente novamente.",
  DRIVE_EXPORT_FAILED:
    "Falha ao ler o template do Google Drive. Tente novamente.",
  // auth / session errors
  UNAUTHORIZED: "Sessão expirada ou inválida. Por favor, faça login novamente.",
  NOT_FOUND: "Recurso não encontrado.",
  METHOD_NOT_ALLOWED: "Método não permitido.",
  INVALID_JSON: "Corpo da requisição inválido.",
  INTERNAL_ERROR: "Erro interno do servidor. Tente novamente.",
  // OAuth flow errors
  OAUTH_MISSING_PARAMS:
    "Parâmetros OAuth ausentes. Tente reconectar sua conta Google.",
  OAUTH_STATE_MISMATCH:
    "Falha de segurança na autenticação OAuth. Tente novamente.",
  OAUTH_DENIED:
    "Acesso ao Google Drive negado. Autorize o acesso para continuar.",
  OAUTH_MISSING_ID_TOKEN:
    "Token de identidade Google não recebido. Tente reconectar.",
  OAUTH_TOKEN_EXCHANGE_FAILED:
    "Falha na troca de token OAuth com o Google. Tente novamente.",
  OAUTH_MISSING_REFRESH_TOKEN:
    "Token de atualização Google não recebido. Tente reconectar.",
  OAUTH_CODE_ISSUE_FAILED: "Falha ao emitir código OAuth. Tente novamente.",
  SUPABASE_SIGNIN_FAILED: "Falha ao autenticar no sistema. Tente novamente.",
  LANDLORD_TOKEN_UPDATE_FAILED:
    "Falha ao salvar credenciais Google. Tente reconectar sua conta.",
  REFRESH_TOKEN_PERSIST_FAILED:
    "Falha ao persistir o token de atualização. Tente reconectar.",
  // signature errors
  SIGNATURE_MARKERS_NOT_FOUND:
    "Marcadores de assinatura não encontrados no documento. Verifique o template.",
  SIGNATURE_REQUEST_NOT_FOUND:
    "Solicitação de assinatura não encontrada. Tente novamente.",
  AUTENTIQUE_FETCH_FAILED: "Falha ao consultar o Autentique. Tente novamente.",
  AUTENTIQUE_UPDATE_FAILED:
    "Falha ao atualizar o status no Autentique. Tente novamente.",
  PDF_EXPORT_FAILED:
    "Falha ao exportar o PDF do Google Drive. Tente novamente.",
  DRIVE_LIST_FAILED:
    "Falha ao listar arquivos no Google Drive. Tente novamente.",
  NO_DOCUMENTS_FOUND:
    "Nenhum documento encontrado para este inquilino. Gere os documentos antes de enviar para assinatura.",
  NO_SIGNERS_RESOLVED:
    "Nenhum signatário encontrado para este contrato. Verifique o cadastro do inquilino.",
  // building errors
  BUILDING_NOT_FOUND:
    "Edifício não encontrado. Por favor, selecione um edifício válido.",
  // template errors
  TEMPLATE_NOT_FOUND:
    "Template não encontrado. Verifique os templates cadastrados.",
  // placeholder errors
  DUPLICATE_PLACEHOLDER:
    "Este campo já está cadastrado. Utilize um nome diferente.",
  INVALID_REQUEST: "Requisição inválida. Verifique os dados enviados.",
  INVALID_FORMAT: "Formato inválido. Verifique os dados enviados.",
  // witness errors
  DUPLICATE_WITNESS:
    "Esta testemunha já está cadastrada. Utilize dados diferentes.",
  // tenant errors
  TENANT_MISSING_LANDLORD:
    "Inquilino sem proprietário associado. Contate o suporte.",
  TENANT_WHATSAPP_MISSING:
    "WhatsApp do inquilino não cadastrado. Atualize o cadastro antes de prosseguir.",
  INVALID_WHATSAPP:
    "Número de WhatsApp inválido. Informe no formato +55 (XX) XXXXX-XXXX.",
  MISSING_FIELDS: "Campos obrigatórios ausentes. Verifique os dados enviados.",
  // property errors
  MISSING_TYPE: "Tipo do imóvel não informado. Por favor, selecione um tipo.",
  MISSING_NAME: "O campo nome é obrigatório.",
  MISSING_ADDRESS: "O campo endereço é obrigatório.",
  MISSING_BUILDING_ID:
    "Edifício não selecionado. Por favor, selecione um edifício.",
  // payment errors
  INVALID_AMOUNT:
    "Valor do pagamento inválido. Informe um valor numérico positivo.",
  INVALID_REFERENCE_MONTH:
    "Mês de referência inválido. Informe no formato YYYY-MM.",
  INVALID_PAID_AT: "Data de pagamento inválida. Informe uma data válida.",
  MISSING_PAID_AT:
    "Data de pagamento não informada. Por favor, informe a data.",
  INVALID_MONTH: "Mês inválido. Informe um valor entre 1 e 12.",
  INVALID_FREQUENCY: "Frequência de lembrete inválida.",
  INVALID_TENANT_ID: "Identificador de inquilino inválido.",
  // whatsapp errors
  WHATSAPP_SEND_FAILED:
    "Falha ao enviar mensagem no WhatsApp. Tente novamente.",
  // workflow errors
  UNKNOWN_INTENT:
    "Intenção não reconhecida. Por favor, escolha uma opção do menu.",
  MISSING_MESSAGE: "Mensagem não informada. Por favor, envie uma mensagem.",
  INVALID_ID: "Identificador inválido.",
};

/**
 * Three-tier error message resolution for intent execute() handlers.
 *
 * Tier 1: ERROR_MAP[code]   → friendly PT message (preferred)
 * Tier 2: backendMessage    → passthrough if present (useful for dynamic messages)
 * Tier 3: generic fallback  → "Ocorreu um erro inesperado. Tente novamente."
 */
export const GENERIC_ERROR_MESSAGE =
  "Ocorreu um erro inesperado. Tente novamente.";

export function resolveErrorMessage(
  code: string,
  backendMessage?: string,
): string {
  const mapped = ERROR_MAP[code];
  if (mapped) return mapped;
  if (backendMessage) return backendMessage;
  return GENERIC_ERROR_MESSAGE;
}

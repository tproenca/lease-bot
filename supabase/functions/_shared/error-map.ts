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
  DB_ERROR: "Erro ao salvar o inquilino. Tente novamente.",
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
};

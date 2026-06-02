// Shared error-code → user-facing Portuguese message map.
//
// Intent handlers (e.g. add-tenant) import this record and use it to translate
// Supabase/domain error codes into friendly messages before returning them to
// the workflow engine.

export const ERROR_MAP: Record<string, string> = {
  GOOGLE_REAUTH_REQUIRED:
    "Sua conexão com o Google Drive expirou. Reconecte sua conta Google nas configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
  INVALID_CPF:
    "O CPF informado não é válido. Por favor, informe o CPF no formato XXX.XXX.XXX-XX.",
  PROPERTY_NOT_FOUND:
    "Imóvel não encontrado. Por favor, selecione um imóvel válido.",
  LANDLORD_NOT_FOUND:
    "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
};

//! 一次性：把 /tmp/ebb-cloud-token.txt 的令牌用当前主机名加密，输出 v2 密文供写回正式库。
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

fn main() {
    let plaintext = std::fs::read_to_string("/tmp/ebb-cloud-token.txt").unwrap().trim().to_string();
    let output = std::process::Command::new("/bin/hostname").output().unwrap();
    let hostname = String::from_utf8(output.stdout).unwrap().trim().to_string();
    let params = scrypt::Params::new(14, 8, 1, 32).unwrap();
    let mut key = [0u8; 32];
    scrypt::scrypt(hostname.as_bytes(), b"ebbinghaus-v2-llm-api-key", &params, &mut key).unwrap();
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let random = uuid::Uuid::new_v4();
    let nonce_bytes: &[u8] = &random.as_bytes()[..12];
    let ct = cipher.encrypt(Nonce::from_slice(nonce_bytes), Payload { msg: plaintext.as_bytes(), aad: b"ebbinghaus-v2-key-cipher-v1" }).unwrap();
    let mut packed = Vec::new();
    packed.extend_from_slice(nonce_bytes);
    packed.extend_from_slice(&ct);
    println!("v2:{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &packed));
}

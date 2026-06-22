(define-fungible-token sbtc-token)

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34))))
  (begin
    (try! (ft-transfer? sbtc-token amount sender recipient))
    (ok true)))

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance sbtc-token who)))

(define-public (mint (amount uint) (recipient principal))
  (ft-mint? sbtc-token amount recipient))

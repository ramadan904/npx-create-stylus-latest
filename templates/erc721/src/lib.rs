// Only run this as a WASM contract if the export-abi feature is not set.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use stylus_sdk::{
    abi::Bytes,
    alloy_primitives::{Address, FixedBytes, U256},
    alloy_sol_types::sol,
    prelude::*,
};

sol_interface! {
    interface IERC721Receiver {
        function onERC721Received(address operator, address from, uint256 token_id, bytes data) external returns (bytes4);
    }
}

sol! {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // The standard ERC-721 errors (ERC-6093), so wallets and agents can decode them by name.
    error ERC721InvalidOwner(address owner);
    error ERC721NonexistentToken(uint256 tokenId);
    error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner);
    error ERC721InsufficientApproval(address operator, uint256 tokenId);
    error ERC721InvalidApprover(address approver);
    error ERC721InvalidOperator(address operator);
    error ERC721InvalidReceiver(address receiver);
    error NotMinter(address caller);
    error ZeroAddress();
}

#[derive(SolidityError)]
pub enum NftError {
    ERC721InvalidOwner(ERC721InvalidOwner),
    ERC721NonexistentToken(ERC721NonexistentToken),
    ERC721IncorrectOwner(ERC721IncorrectOwner),
    ERC721InsufficientApproval(ERC721InsufficientApproval),
    ERC721InvalidApprover(ERC721InvalidApprover),
    ERC721InvalidOperator(ERC721InvalidOperator),
    ERC721InvalidReceiver(ERC721InvalidReceiver),
    NotMinter(NotMinter),
    ZeroAddress(ZeroAddress),
}

/// `onERC721Received.selector`: what a contract must return to accept a token through `safeTransferFrom`.
const RECEIVED: [u8; 4] = [0x15, 0x0b, 0x7a, 0x02];
const IERC165: [u8; 4] = [0x01, 0xff, 0xc9, 0xa7];
const IERC721: [u8; 4] = [0x80, 0xac, 0x58, 0xcd];
const IERC721_METADATA: [u8; 4] = [0x5b, 0x5e, 0x13, 0x9f];

sol_storage! {
    #[entrypoint]
    pub struct Nft {
        string name;
        string symbol;
        string base_uri;
        address minter;
        uint256 minted;
        uint256 total_supply;
        mapping(uint256 => address) owners;
        mapping(address => uint256) balances;
        mapping(uint256 => address) token_approvals;
        mapping(address => mapping(address => bool)) operator_approvals;
    }
}

#[public]
impl Nft {
    /// Runs once, atomically, at deploy time. `minter` is the only account that can mint; pass it explicitly
    /// (`msg_sender` inside a Stylus constructor is the deployer helper contract, not you). Token `id`'s metadata is
    /// at `base_uri` + `id`, e.g. `ipfs://<cid>/7`; an empty `base_uri` means no metadata.
    #[constructor]
    pub fn constructor(
        &mut self,
        name: String,
        symbol: String,
        base_uri: String,
        minter: Address,
    ) -> Result<(), NftError> {
        if minter == Address::ZERO {
            return Err(NftError::ZeroAddress(ZeroAddress {}));
        }
        self.name.set_str(name);
        self.symbol.set_str(symbol);
        self.base_uri.set_str(base_uri);
        self.minter.set(minter);
        Ok(())
    }

    pub fn name(&self) -> String {
        self.name.get_string()
    }

    pub fn symbol(&self) -> String {
        self.symbol.get_string()
    }

    pub fn minter(&self) -> Address {
        self.minter.get()
    }

    /// Tokens in existence (minted minus burned).
    pub fn total_supply(&self) -> U256 {
        self.total_supply.get()
    }

    pub fn balance_of(&self, owner: Address) -> Result<U256, NftError> {
        if owner == Address::ZERO {
            return Err(NftError::ERC721InvalidOwner(ERC721InvalidOwner { owner }));
        }
        Ok(self.balances.get(owner))
    }

    pub fn owner_of(&self, token_id: U256) -> Result<Address, NftError> {
        self.require_owned(token_id)
    }

    #[selector(name = "tokenURI")]
    pub fn token_uri(&self, token_id: U256) -> Result<String, NftError> {
        self.require_owned(token_id)?;
        let base = self.base_uri.get_string();
        if base.is_empty() {
            return Ok(base);
        }
        Ok(base + &decimal(token_id))
    }

    pub fn supports_interface(&self, interface_id: FixedBytes<4>) -> bool {
        let id = interface_id.0;
        id == IERC165 || id == IERC721 || id == IERC721_METADATA
    }

    pub fn get_approved(&self, token_id: U256) -> Result<Address, NftError> {
        self.require_owned(token_id)?;
        Ok(self.token_approvals.get(token_id))
    }

    pub fn is_approved_for_all(&self, owner: Address, operator: Address) -> bool {
        self.operator_approvals.getter(owner).get(operator)
    }

    /// Lets `to` transfer this one token (the zero address clears it). Only the owner or one of its operators.
    pub fn approve(&mut self, to: Address, token_id: U256) -> Result<(), NftError> {
        let owner = self.require_owned(token_id)?;
        let caller = self.vm().msg_sender();
        if caller != owner && !self.is_approved_for_all(owner, caller) {
            return Err(NftError::ERC721InvalidApprover(ERC721InvalidApprover {
                approver: caller,
            }));
        }
        self.token_approvals.setter(token_id).set(to);
        self.vm().log(Approval {
            owner,
            approved: to,
            tokenId: token_id,
        });
        Ok(())
    }

    /// Lets `operator` transfer all of the caller's tokens, now and later, until revoked.
    pub fn set_approval_for_all(
        &mut self,
        operator: Address,
        approved: bool,
    ) -> Result<(), NftError> {
        if operator == Address::ZERO {
            return Err(NftError::ERC721InvalidOperator(ERC721InvalidOperator {
                operator,
            }));
        }
        let owner = self.vm().msg_sender();
        self.operator_approvals
            .setter(owner)
            .insert(operator, approved);
        self.vm().log(ApprovalForAll {
            owner,
            operator,
            approved,
        });
        Ok(())
    }

    /// Moves a token without asking the receiver. Use `safeTransferFrom` when `to` may be a contract.
    pub fn transfer_from(
        &mut self,
        from: Address,
        to: Address,
        token_id: U256,
    ) -> Result<(), NftError> {
        let caller = self.vm().msg_sender();
        self.move_token(caller, from, to, token_id)
    }

    #[selector(name = "safeTransferFrom")]
    pub fn safe_transfer_from(
        &mut self,
        from: Address,
        to: Address,
        token_id: U256,
    ) -> Result<(), NftError> {
        self.safe_transfer_from_with_data(from, to, token_id, Bytes::default())
    }

    /// Moves a token and, if `to` is a contract, requires it to accept it (`onERC721Received`), so a token cannot get
    /// stuck in a contract that does not know it holds one.
    #[selector(name = "safeTransferFrom")]
    pub fn safe_transfer_from_with_data(
        &mut self,
        from: Address,
        to: Address,
        token_id: U256,
        data: Bytes,
    ) -> Result<(), NftError> {
        let caller = self.vm().msg_sender();
        self.move_token(caller, from, to, token_id)?;
        self.check_receiver(caller, from, to, token_id, data)
    }

    /// Mints the next token id (1, 2, 3, ...) to `to`. Only the minter. Returns the new id.
    pub fn mint(&mut self, to: Address) -> Result<U256, NftError> {
        let caller = self.vm().msg_sender();
        if caller != self.minter.get() {
            return Err(NftError::NotMinter(NotMinter { caller }));
        }
        if to == Address::ZERO {
            return Err(NftError::ERC721InvalidReceiver(ERC721InvalidReceiver {
                receiver: to,
            }));
        }
        let token_id = self.minted.get() + U256::from(1);
        self.minted.set(token_id);
        self.total_supply
            .set(self.total_supply.get() + U256::from(1));
        self.owners.setter(token_id).set(to);
        let held = self.balances.get(to) + U256::from(1);
        self.balances.setter(to).set(held);
        self.vm().log(Transfer {
            from: Address::ZERO,
            to,
            tokenId: token_id,
        });
        Ok(token_id)
    }

    /// Destroys a token. The owner, its operator, or the account approved for the token.
    pub fn burn(&mut self, token_id: U256) -> Result<(), NftError> {
        let owner = self.require_owned(token_id)?;
        let caller = self.vm().msg_sender();
        if !self.may_move(caller, owner, token_id) {
            return Err(NftError::ERC721InsufficientApproval(
                ERC721InsufficientApproval {
                    operator: caller,
                    tokenId: token_id,
                },
            ));
        }
        self.token_approvals.setter(token_id).set(Address::ZERO);
        self.owners.setter(token_id).set(Address::ZERO);
        let held = self.balances.get(owner) - U256::from(1);
        self.balances.setter(owner).set(held);
        self.total_supply
            .set(self.total_supply.get() - U256::from(1));
        self.vm().log(Transfer {
            from: owner,
            to: Address::ZERO,
            tokenId: token_id,
        });
        Ok(())
    }
}

/// `id` in decimal. Written out by hand: `to_string()` would pull Rust's formatting machinery into the contract and push
/// it past Stylus's 24 KB size limit. Only called for existing tokens, whose ids count up from 1 and so fit in 64 bits.
fn decimal(id: U256) -> String {
    let mut n = id.as_limbs()[0];
    let mut digits = Vec::new();
    loop {
        digits.push(b'0' + (n % 10) as u8);
        n /= 10;
        if n == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

// Internal helpers (not exposed in the ABI).
impl Nft {
    fn require_owned(&self, token_id: U256) -> Result<Address, NftError> {
        let owner = self.owners.get(token_id);
        if owner == Address::ZERO {
            return Err(NftError::ERC721NonexistentToken(ERC721NonexistentToken {
                tokenId: token_id,
            }));
        }
        Ok(owner)
    }

    fn may_move(&self, caller: Address, owner: Address, token_id: U256) -> bool {
        caller == owner
            || self.is_approved_for_all(owner, caller)
            || self.token_approvals.get(token_id) == caller
    }

    /// Checks everything first, then moves: a refused transfer changes nothing.
    fn move_token(
        &mut self,
        caller: Address,
        from: Address,
        to: Address,
        token_id: U256,
    ) -> Result<(), NftError> {
        let owner = self.require_owned(token_id)?;
        if owner != from {
            return Err(NftError::ERC721IncorrectOwner(ERC721IncorrectOwner {
                sender: from,
                tokenId: token_id,
                owner,
            }));
        }
        if to == Address::ZERO {
            return Err(NftError::ERC721InvalidReceiver(ERC721InvalidReceiver {
                receiver: to,
            }));
        }
        if !self.may_move(caller, owner, token_id) {
            return Err(NftError::ERC721InsufficientApproval(
                ERC721InsufficientApproval {
                    operator: caller,
                    tokenId: token_id,
                },
            ));
        }
        // A per-token approval does not survive a transfer.
        self.token_approvals.setter(token_id).set(Address::ZERO);
        let held = self.balances.get(from) - U256::from(1);
        self.balances.setter(from).set(held);
        let held = self.balances.get(to) + U256::from(1);
        self.balances.setter(to).set(held);
        self.owners.setter(token_id).set(to);
        self.vm().log(Transfer {
            from,
            to,
            tokenId: token_id,
        });
        Ok(())
    }

    /// A contract receiving a token must answer `onERC721Received` with its selector; anything else reverts the whole
    /// transfer. Accounts without code are not asked.
    fn check_receiver(
        &mut self,
        operator: Address,
        from: Address,
        to: Address,
        token_id: U256,
        data: Bytes,
    ) -> Result<(), NftError> {
        if self.vm().code_size(to) == 0 {
            return Ok(());
        }
        let receiver = IERC721Receiver::new(to);
        let call = Call::new_mutating(self);
        match receiver.on_erc_721_received(self.vm(), call, operator, from, token_id, data) {
            Ok(answer) if answer.0 == RECEIVED => Ok(()),
            _ => Err(NftError::ERC721InvalidReceiver(ERC721InvalidReceiver {
                receiver: to,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stylus_sdk::{alloy_primitives::address, alloy_sol_types::SolCall, testing::*};

    sol! {
        function onERC721Received(address operator, address from, uint256 token_id, bytes data) external returns (bytes4);
    }

    const MINTER: Address = address!("0xA11CE00000000000000000000000000000000001");
    const BOB: Address = address!("0xB0B0000000000000000000000000000000000002");
    const CAROL: Address = address!("0xCA40100000000000000000000000000000000003");
    const VAULT: Address = address!("0x7A0170000000000000000000000000000000000F");

    fn deployed() -> (TestVM, Nft) {
        let vm = TestVM::default();
        vm.set_sender(MINTER);
        let mut nft = Nft::from(&vm);
        assert!(
            nft.constructor(
                "Buildathon Badge".into(),
                "BADGE".into(),
                "ipfs://cid/".into(),
                MINTER
            )
            .is_ok()
        );
        (vm, nft)
    }

    fn one() -> U256 {
        U256::from(1)
    }

    #[test]
    fn constructor_sets_metadata_and_rejects_a_zero_minter() {
        let (_vm, nft) = deployed();
        assert_eq!(nft.name(), "Buildathon Badge");
        assert_eq!(nft.symbol(), "BADGE");
        assert_eq!(nft.minter(), MINTER);
        let vm = TestVM::default();
        let mut bad = Nft::from(&vm);
        assert!(
            bad.constructor("A".into(), "A".into(), "".into(), Address::ZERO)
                .is_err()
        );
    }

    #[test]
    fn only_the_minter_mints_and_ids_count_up_from_one() {
        let (vm, mut nft) = deployed();
        assert_eq!(nft.mint(BOB).ok(), Some(one()));
        assert_eq!(nft.mint(BOB).ok(), Some(U256::from(2)));
        assert_eq!(nft.balance_of(BOB).ok(), Some(U256::from(2)));
        assert_eq!(nft.total_supply(), U256::from(2));
        assert_eq!(
            nft.token_uri(U256::from(2)).ok().as_deref(),
            Some("ipfs://cid/2")
        );
        assert!(nft.mint(Address::ZERO).is_err());
        vm.set_sender(BOB);
        assert!(matches!(nft.mint(BOB), Err(NftError::NotMinter(_))));
    }

    #[test]
    fn unknown_tokens_and_the_zero_owner_are_errors() {
        let (_vm, nft) = deployed();
        assert!(matches!(
            nft.owner_of(U256::from(9)),
            Err(NftError::ERC721NonexistentToken(_))
        ));
        assert!(nft.token_uri(U256::from(9)).is_err());
        assert!(nft.get_approved(U256::from(9)).is_err());
        assert!(matches!(
            nft.balance_of(Address::ZERO),
            Err(NftError::ERC721InvalidOwner(_))
        ));
    }

    #[test]
    fn transfers_need_the_owner_an_operator_or_the_approved_account() {
        let (vm, mut nft) = deployed();
        assert!(nft.mint(BOB).is_ok());
        vm.set_sender(CAROL);
        assert!(matches!(
            nft.transfer_from(BOB, CAROL, one()),
            Err(NftError::ERC721InsufficientApproval(_))
        ));

        vm.set_sender(BOB);
        assert!(nft.approve(CAROL, one()).is_ok());
        vm.set_sender(CAROL);
        assert!(nft.transfer_from(BOB, CAROL, one()).is_ok());
        assert_eq!(nft.owner_of(one()).ok(), Some(CAROL));
        assert_eq!(
            nft.get_approved(one()).ok(),
            Some(Address::ZERO),
            "the approval is cleared by the transfer"
        );

        assert!(nft.set_approval_for_all(BOB, true).is_ok());
        vm.set_sender(BOB);
        assert!(
            nft.transfer_from(CAROL, BOB, one()).is_ok(),
            "an operator moves any of the owner's tokens"
        );
        assert!(matches!(
            nft.transfer_from(CAROL, BOB, one()),
            Err(NftError::ERC721IncorrectOwner(_))
        ));
        assert!(matches!(
            nft.transfer_from(BOB, Address::ZERO, one()),
            Err(NftError::ERC721InvalidReceiver(_))
        ));
    }

    #[test]
    fn approve_is_for_the_owner_or_an_operator_only() {
        let (vm, mut nft) = deployed();
        assert!(nft.mint(BOB).is_ok());
        vm.set_sender(CAROL);
        assert!(matches!(
            nft.approve(CAROL, one()),
            Err(NftError::ERC721InvalidApprover(_))
        ));
        assert!(nft.set_approval_for_all(Address::ZERO, true).is_err());
    }

    #[test]
    fn safe_transfer_asks_a_contract_receiver_and_refuses_a_wrong_answer() {
        let (vm, mut nft) = deployed();
        assert!(nft.mint(BOB).is_ok());
        assert!(nft.mint(BOB).is_ok());
        vm.set_code(VAULT, vec![0x60]);
        let ask = |id: u64| {
            onERC721ReceivedCall {
                operator: BOB,
                from: BOB,
                token_id: U256::from(id),
                data: Default::default(),
            }
            .abi_encode()
        };
        let mut accept = RECEIVED.to_vec();
        accept.resize(32, 0);
        vm.set_sender(BOB);

        // The test VM returns the data of the most recent mock, so each answer is mocked right before its call.
        vm.mock_call(VAULT, ask(1), U256::ZERO, Ok(accept));
        assert!(nft.safe_transfer_from(BOB, VAULT, one()).is_ok());
        assert_eq!(nft.owner_of(one()).ok(), Some(VAULT));

        vm.mock_call(VAULT, ask(2), U256::ZERO, Ok(vec![0u8; 32]));
        assert!(matches!(
            nft.safe_transfer_from(BOB, VAULT, U256::from(2)),
            Err(NftError::ERC721InvalidReceiver(_))
        ));
        // On-chain that error reverts the whole transaction, undoing the move; this test VM has no rollback, so the
        // last case uses a token of its own.
        vm.set_sender(MINTER);
        assert!(nft.mint(BOB).is_ok());
        vm.set_sender(BOB);
        assert!(
            nft.safe_transfer_from(BOB, CAROL, U256::from(3)).is_ok(),
            "an account without code is not asked"
        );
    }

    #[test]
    fn decimal_writes_any_id() {
        assert_eq!(decimal(U256::ZERO), "0");
        assert_eq!(decimal(U256::from(7)), "7");
        assert_eq!(decimal(U256::from(1_234_567_890u64)), "1234567890");
        assert_eq!(decimal(U256::from(u64::MAX)), u64::MAX.to_string());
    }

    #[test]
    fn burn_removes_the_token() {
        let (vm, mut nft) = deployed();
        assert!(nft.mint(BOB).is_ok());
        vm.set_sender(CAROL);
        assert!(nft.burn(one()).is_err());
        vm.set_sender(BOB);
        assert!(nft.burn(one()).is_ok());
        assert!(nft.owner_of(one()).is_err());
        assert_eq!(nft.balance_of(BOB).ok(), Some(U256::ZERO));
        assert_eq!(nft.total_supply(), U256::ZERO);
    }

    #[test]
    fn supports_the_erc165_erc721_and_metadata_interfaces() {
        let (_vm, nft) = deployed();
        for id in [IERC165, IERC721, IERC721_METADATA] {
            assert!(nft.supports_interface(FixedBytes(id)));
        }
        assert!(!nft.supports_interface(FixedBytes([0xff; 4])));
    }
}

/// Property-based tests: random sequences of mints, approvals, transfers and burns, checked step by step against a
/// reference model of who owns what and who may move it. A refused call must change nothing.
#[cfg(test)]
mod properties {
    use super::*;
    use proptest::prelude::*;
    use stylus_sdk::{alloy_primitives::address, testing::*};

    const ACTORS: [Address; 4] = [
        address!("0xA11CE00000000000000000000000000000000001"),
        address!("0xB0B0000000000000000000000000000000000002"),
        address!("0xCA40100000000000000000000000000000000003"),
        address!("0xDA7E000000000000000000000000000000000004"),
    ];
    const IDS: u64 = 6; // the token ids the operations pick from; some are never minted

    #[derive(Debug, Clone)]
    enum Op {
        Mint {
            by: usize,
            to: usize,
        },
        Approve {
            by: usize,
            to: usize,
            id: u64,
        },
        Operator {
            by: usize,
            op: usize,
            on: bool,
        },
        Transfer {
            by: usize,
            from: usize,
            to: usize,
            id: u64,
        },
        Burn {
            by: usize,
            id: u64,
        },
    }

    fn op() -> impl Strategy<Value = Op> {
        let who = 0..ACTORS.len();
        let id = 1..=IDS;
        prop_oneof![
            (who.clone(), who.clone()).prop_map(|(by, to)| Op::Mint { by, to }),
            (who.clone(), who.clone(), id.clone()).prop_map(|(by, to, id)| Op::Approve {
                by,
                to,
                id
            }),
            (who.clone(), who.clone(), any::<bool>()).prop_map(|(by, op, on)| Op::Operator {
                by,
                op,
                on
            }),
            (who.clone(), who.clone(), who.clone(), id.clone())
                .prop_map(|(by, from, to, id)| Op::Transfer { by, from, to, id }),
            (who, id).prop_map(|(by, id)| Op::Burn { by, id }),
        ]
    }

    /// The reference model: owner per token, per-token approval, operator approvals.
    #[derive(Clone, PartialEq, Debug, Default)]
    struct Model {
        owner: [Option<usize>; IDS as usize + 1],
        approved: [Option<usize>; IDS as usize + 1],
        operators: [[bool; 4]; 4],
        minted: u64,
    }

    impl Model {
        fn may_move(&self, by: usize, id: usize) -> bool {
            let owner = self.owner[id].unwrap();
            by == owner || self.operators[owner][by] || self.approved[id] == Some(by)
        }
    }

    fn observe(nft: &Nft) -> Vec<String> {
        let mut seen = Vec::new();
        for id in 1..=IDS {
            let id = U256::from(id);
            seen.push(format!(
                "{:?}/{:?}",
                nft.owner_of(id).ok(),
                nft.get_approved(id).ok()
            ));
        }
        for a in ACTORS {
            seen.push(format!("{:?}", nft.balance_of(a).ok()));
            for b in ACTORS {
                seen.push(format!("{}", nft.is_approved_for_all(a, b)));
            }
        }
        seen.push(format!("{}", nft.total_supply()));
        seen
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn the_contract_matches_a_reference_model(ops in prop::collection::vec(op(), 0..50)) {
            let vm = TestVM::default();
            let mut nft = Nft::from(&vm);
            prop_assert!(nft.constructor("N".into(), "N".into(), "".into(), ACTORS[0]).is_ok());
            let mut m = Model::default();

            for op in ops {
                let before = observe(&nft);
                let ok = match op.clone() {
                    Op::Mint { by, to } => {
                        if by == 0 && m.minted >= IDS { continue; } // past the ids the model tracks
                        vm.set_sender(ACTORS[by]);
                        let ok = nft.mint(ACTORS[to]).is_ok();
                        let expect = by == 0;
                        prop_assert_eq!(ok, expect, "mint {:?}", op);
                        if ok { m.minted += 1; m.owner[m.minted as usize] = Some(to); }
                        ok
                    }
                    Op::Approve { by, to, id } => {
                        vm.set_sender(ACTORS[by]);
                        let ok = nft.approve(ACTORS[to], U256::from(id)).is_ok();
                        let i = id as usize;
                        let expect = m.owner[i].is_some_and(|o| o == by || m.operators[o][by]);
                        prop_assert_eq!(ok, expect, "approve {:?}", op);
                        if ok { m.approved[i] = Some(to); }
                        ok
                    }
                    Op::Operator { by, op: who, on } => {
                        vm.set_sender(ACTORS[by]);
                        prop_assert!(nft.set_approval_for_all(ACTORS[who], on).is_ok());
                        m.operators[by][who] = on;
                        true
                    }
                    Op::Transfer { by, from, to, id } => {
                        vm.set_sender(ACTORS[by]);
                        let ok = nft.transfer_from(ACTORS[from], ACTORS[to], U256::from(id)).is_ok();
                        let i = id as usize;
                        let expect = m.owner[i] == Some(from) && m.may_move(by, i);
                        prop_assert_eq!(ok, expect, "transfer {:?}", op);
                        if ok { m.owner[i] = Some(to); m.approved[i] = None; }
                        ok
                    }
                    Op::Burn { by, id } => {
                        vm.set_sender(ACTORS[by]);
                        let ok = nft.burn(U256::from(id)).is_ok();
                        let i = id as usize;
                        let expect = m.owner[i].is_some() && m.may_move(by, i);
                        prop_assert_eq!(ok, expect, "burn {:?}", op);
                        if ok { m.owner[i] = None; m.approved[i] = None; }
                        ok
                    }
                };
                if !ok {
                    prop_assert_eq!(observe(&nft), before, "a refused call must change nothing: {:?}", op);
                }
                // The contract agrees with the model on every token, every balance and the supply.
                for id in 1..=IDS as usize {
                    let owner = nft.owner_of(U256::from(id)).ok();
                    prop_assert_eq!(owner, m.owner[id].map(|o| ACTORS[o]));
                    if m.owner[id].is_some() {
                        let approved = nft.get_approved(U256::from(id)).ok();
                        prop_assert_eq!(approved, Some(m.approved[id].map(|a| ACTORS[a]).unwrap_or(Address::ZERO)));
                    }
                }
                for (i, a) in ACTORS.iter().enumerate() {
                    let held = m.owner.iter().filter(|o| **o == Some(i)).count();
                    prop_assert_eq!(nft.balance_of(*a).ok(), Some(U256::from(held)));
                }
                let live = m.owner.iter().filter(|o| o.is_some()).count();
                prop_assert_eq!(nft.total_supply(), U256::from(live));
            }
        }
    }
}

// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract StreamVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 21445784821755146207907969872968807383196038468560439552644821940992554262707;
    uint256 constant deltax2 = 16136868622456479776152877803265339214439994027095327568341536791441467246233;
    uint256 constant deltay1 = 8772777109611796098236055208648517138138394284415895457098800058258749465198;
    uint256 constant deltay2 = 15122168433317501790604397564194758221357192709030359018128561834890876976791;

    
    uint256 constant IC0x = 924966109552542127368233088615699526689791750591272693275257173077771731520;
    uint256 constant IC0y = 16489904240831297267884706384994174011971888032385349123867431466206035264567;
    
    uint256 constant IC1x = 9347319782973813472089685079472807084709083451139296527694320627332513259458;
    uint256 constant IC1y = 16591374601121537480926260628534566067074163529364331396720131526425683867005;
    
    uint256 constant IC2x = 9293470628503075717407281451594734122540619608832680917353323471631556216392;
    uint256 constant IC2y = 8787424225103127748703886144200394528450858868433242191078671093293431591740;
    
    uint256 constant IC3x = 6941510608438306284173456738434735616483794897598525111416984772929551581900;
    uint256 constant IC3y = 10212933911711012034294732674394006247460247057991284114958151686893212427204;
    
    uint256 constant IC4x = 13243838524171067289047454235738937191944290296029833379025078407429564097983;
    uint256 constant IC4y = 3479324896421059013074881568254432362698703686572325560559440088037952352650;
    
    uint256 constant IC5x = 19978878231733738269212200930855986357428889732913238647080257428077702673139;
    uint256 constant IC5y = 19325640714810458261655353809543777702431998564343523849556746144157317373956;
    
    uint256 constant IC6x = 59989453074690815796662123205942615975906020251150498345628809440274738715;
    uint256 constant IC6y = 5346213803839814144588138107826697648170497970172432017393464212172505094761;
    
    uint256 constant IC7x = 7384381985000135485448845318592996051819338575188630906558142928158690004281;
    uint256 constant IC7y = 14207845131520894973991076714357277393077996584309020476060511728535330021283;
    
    uint256 constant IC8x = 8162121687845241362420711667430424536005530037128978680278483300104292116947;
    uint256 constant IC8y = 11252355718579126749264856479734270570022451867762872932302498694927812498117;
    
    uint256 constant IC9x = 16736763751855338300528758967425920677349330652873255910365036242346475558942;
    uint256 constant IC9y = 14889946957192411427462312596577413456239935378541808834517255886888958941977;
    
    uint256 constant IC10x = 1406590896140352105905594404269519179924059741980001356882008781152024624795;
    uint256 constant IC10y = 21326195576776341329611277055727394245698490886870917927287296954621312792184;
    
    uint256 constant IC11x = 16292414745793367353231008391397113101473081242105535383249677618967020229777;
    uint256 constant IC11y = 14576567099761647256823152021098555146545856820413634075134382570622383958458;
    
    uint256 constant IC12x = 4960804476660452883266829115819250297270322925497218522049635004434694405341;
    uint256 constant IC12y = 18642322619296803924429158719171712608004836118017204609413428886268029462321;
    
    uint256 constant IC13x = 1214996157903719945054633543640799637048896430961340515959700559506299818427;
    uint256 constant IC13y = 21449520399209288643050558032910341898406851937405783835806615628789657651273;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[13] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

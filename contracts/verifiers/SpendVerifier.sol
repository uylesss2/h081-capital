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

contract SpendVerifier {
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
    uint256 constant deltax1 = 8582880455897037385174274027302035914232546107104856187405816855004819392466;
    uint256 constant deltax2 = 14501669637570627379470821027557037618619931755332085256390806289165420330858;
    uint256 constant deltay1 = 21355439843422388899090529637117164248400158080239360039032263997319033567813;
    uint256 constant deltay2 = 21884997929582139848737912712478442567566367270654524139562337292481416788915;

    
    uint256 constant IC0x = 6976767925212799323292133239097509274179130474921847603710069688598441258178;
    uint256 constant IC0y = 4297786099973475461273861760095484173256453646614794114726183317421512239281;
    
    uint256 constant IC1x = 14619678189228641037034663586466157323988721641660396669933737632594855966802;
    uint256 constant IC1y = 18796493044467967970389259188613679019289278718610250382120415760931411457552;
    
    uint256 constant IC2x = 12632874062022447205801744743674428734316776124452274112011412580859897253240;
    uint256 constant IC2y = 19013097795227276415309251432989278308423454850474249556713359099965871031037;
    
    uint256 constant IC3x = 20063507427686957060243590160785033869336933866555457646600508852017217974411;
    uint256 constant IC3y = 11192189996169798943387329116456067406640827425894710304985207794299596439289;
    
    uint256 constant IC4x = 19920757506941333172086686592285265570417815753931539631250862358705067921943;
    uint256 constant IC4y = 6514153946161392077019902946628991671591444120174507381793535290744816117644;
    
    uint256 constant IC5x = 14060194279167289174141416613875566090087223827238514659007178787137834048713;
    uint256 constant IC5y = 20059534069726139493483803594465629086224945601402586759197629591749886011140;
    
    uint256 constant IC6x = 14600008296198685942968796287402054432482514881171768053495499477267303356853;
    uint256 constant IC6y = 1448228952425544272750671518694047624952432976320026948530412921269254745883;
    
    uint256 constant IC7x = 18871273708968986149804925673124457361635078013419807497768389647247688631099;
    uint256 constant IC7y = 3047688086031978994542756451976226729883739520095096531798382286742431497546;
    
    uint256 constant IC8x = 19844786253104589082479543949150309851069650260548182727920125368287591360014;
    uint256 constant IC8y = 10129055571623730594119451106529994722142946448517759486880742722133791376196;
    
    uint256 constant IC9x = 13059392017866505227993425892772738603089290857463833539617606420463372635327;
    uint256 constant IC9y = 7048754986977763891293425053789731236555825847144177648890636988030310038638;
    
    uint256 constant IC10x = 4946264846511210671860668035326813038402858329503214584104568930001425128299;
    uint256 constant IC10y = 18313136998425274207629628788746280451465755731425444557415361596490061128428;
    
    uint256 constant IC11x = 7880666892260868834770391694302065178427270860472667439162610977056473332209;
    uint256 constant IC11y = 457373849521144014716685839829996300862471045604021386994805859234630306102;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[11] calldata _pubSignals) public view returns (bool) {
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
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }

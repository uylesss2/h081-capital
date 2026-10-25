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
    uint256 constant alphax  = 12017019693850155804776661966626903625658038027663161932540092509356485998844;
    uint256 constant alphay  = 3890627203793886091738697557938730734916718218094444210478213872524560133536;
    uint256 constant betax1  = 16634438569144509046320486794661047864325709909516351894999044395552743236065;
    uint256 constant betax2  = 6547916658235308366947843829845169896925522156450766991765314287640068388015;
    uint256 constant betay1  = 12276857391198640165700878803551036504292954567401124742311971291583919679634;
    uint256 constant betay2  = 12311070576328100855945125129337469341109788993640618873616577081403324735298;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 7987731927330138997242015375312321502868484479972060231139180274670310245067;
    uint256 constant deltax2 = 10805799418221828547927944456775478741967234462645532416121114221555959707684;
    uint256 constant deltay1 = 1670628393070129317913325801659951315337051108395123673257437663808161012166;
    uint256 constant deltay2 = 18989108572193512754004146947135509295298638966047210074461199564312835453376;

    
    uint256 constant IC0x = 13807704326370927025181156442306914467122550122870128246650282437403696249069;
    uint256 constant IC0y = 7400471015918707514373294644028001822919260961682860805278904241319190989584;
    
    uint256 constant IC1x = 20555719091114011034340720254180949434737509433826955815558178699185106796870;
    uint256 constant IC1y = 14887342784808548692904746893623102448375896853802008143401042568035084703299;
    
    uint256 constant IC2x = 13734941868481978650060806182001327585469551277534775810623698532453222305612;
    uint256 constant IC2y = 7306650009834160496016235724007759979867917632286871384462090583000549174107;
    
    uint256 constant IC3x = 16535348258470904588544593068863250518093591175042950508908408718140681379928;
    uint256 constant IC3y = 14600852838831694791429377640533334835940871323833492551519339762323062770001;
    
    uint256 constant IC4x = 6726462249190200351439225471410601283590231143865075709682356813598178903945;
    uint256 constant IC4y = 17658962736030283497418904595728588726003562700543038662928745098076523967113;
    
    uint256 constant IC5x = 12391665597818395674668416171544790569467459810538140405048894211189267870501;
    uint256 constant IC5y = 6856508443497307294545164449775294557225302774735987701204581531735538085256;
    
    uint256 constant IC6x = 5970537707985584028085251316018100032743596342145009534129286440843171230043;
    uint256 constant IC6y = 13566800277551005359734703113970685063165370015811803580772096029239648779082;
    
    uint256 constant IC7x = 11201414021199412453451778920284994709890175696639997616647244721947807688045;
    uint256 constant IC7y = 12858134375438711956915882649299517585896607085724622964244137472971509243393;
    
    uint256 constant IC8x = 5703798463758840031237453005832010071001128607858870412888879561312853874381;
    uint256 constant IC8y = 3676315980559916260879403283850596300308195538968679273837759805496417727160;
    
    uint256 constant IC9x = 15272096091689103731412211454916267697753879771937497872654189795182273943582;
    uint256 constant IC9y = 3073484392693983117877404778194565533070572489703628779584873605955868287753;
    
    uint256 constant IC10x = 14061747362153358643198601864983981411211630349092323395034153436884766711456;
    uint256 constant IC10y = 8999895005418326592449219834560648040688386534597483312003523044888765048335;
    
    uint256 constant IC11x = 3579039417529542101550797445381877574465221383333998751245485425646977144763;
    uint256 constant IC11y = 11338017519242341091091447623420639755135241162580325236713308726802984650819;
    
 
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
